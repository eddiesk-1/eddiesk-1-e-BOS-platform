/**
 * 021_payments
 *
 * Real checkout: a visitor buys published items, the server creates a
 * pending order plus a payment row, and ONLY a verified provider event
 * (signed webhook, or a server-side call to the provider's verify API)
 * can move that payment to 'paid'. Nothing a browser says can.
 *
 * Provider-neutral on purpose: payments.provider is a text column and the
 * functions below take the provider as data. Paystack is the first (and
 * only) implementation wired up in the application code.
 *
 * MONEY RULES
 *   - amounts are integers in the currency's minor unit (pesewas for GHS):
 *     payments.amount_minor is bigint. No floats anywhere.
 *   - order totals stay numeric(14,2); amount_minor = total * 100 computed
 *     in SQL numeric arithmetic, never in JavaScript.
 *   - a 'success' event whose amount or currency differs from the payment
 *     row is recorded and REJECTED — the payment stays unpaid.
 *
 * IDEMPOTENCY
 *   payment_events has UNIQUE (provider, event_key). A redelivered webhook
 *   (providers retry) hits the unique constraint, applies nothing, and the
 *   caller is told it was a duplicate. The payment row is locked
 *   (FOR UPDATE) while an event is applied so two concurrent deliveries
 *   cannot both transition it.
 *
 * ORDER LIFECYCLE: orders.status is free text in this schema. Checkout
 * orders start as 'pending_payment' and become 'paid'. The public product
 * stream (routes/productStream.ts) ignores 'pending_payment' orders so
 * unpaid carts never count as sales.
 *
 * NOT IMPLEMENTED (deliberately): refunds. Refund-related provider events
 * are stored in payment_events for audit but do not change a payment.
 *
 * Like migrations 013/016/020, the functions here read and write
 * FORCE-RLS tables as the function owner (superuser or BYPASSRLS needed).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE payments (
      id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id                 uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      business_id              uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      conversation_id          uuid NULL REFERENCES conversations(id) ON DELETE SET NULL,
      provider                 text NOT NULL,
      reference                text NOT NULL,
      amount_minor             bigint NOT NULL CHECK (amount_minor > 0),
      currency                 text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      status                   text NOT NULL DEFAULT 'initialized'
                                 CHECK (status IN ('initialized', 'paid', 'failed', 'abandoned')),
      checkout_email           text NOT NULL,
      provider_transaction_id  text NULL,
      paid_at                  timestamptz NULL,
      created_at               timestamptz NOT NULL DEFAULT now(),
      updated_at               timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT paid_has_timestamp CHECK ((status = 'paid') = (paid_at IS NOT NULL))
    );
  `);
  pgm.sql(`CREATE UNIQUE INDEX idx_payments_reference ON payments(reference);`);
  pgm.sql(`CREATE INDEX idx_payments_order_id ON payments(order_id);`);
  pgm.sql(`CREATE INDEX idx_payments_business_id ON payments(business_id);`);
  pgm.sql(`CREATE INDEX idx_payments_conversation_id ON payments(conversation_id);`);

  // Staff can READ payments for businesses they can see. All writes go
  // through the functions below (RLS enabled, not forced, so the function
  // owner can write).
  pgm.sql(`GRANT SELECT ON payments TO app_owner_partner, app_worker;`);
  pgm.sql(`ALTER TABLE payments ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`
    CREATE POLICY tenant_isolation ON payments
      FOR SELECT
      TO app_owner_partner, app_worker
      USING (is_business_visible_to_caller(payments.business_id));
  `);

  // Audit trail + idempotency. No grants, no policies: functions only.
  pgm.sql(`
    CREATE TABLE payment_events (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider     text NOT NULL,
      event_key    text NOT NULL,
      event_type   text NOT NULL,
      reference    text NULL,
      outcome      text NOT NULL DEFAULT 'received',
      payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
      received_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider, event_key)
    );
  `);
  pgm.sql(`CREATE INDEX idx_payment_events_reference ON payment_events(reference);`);

  // ------------------------------------------------------------------
  // checkout_create
  // ------------------------------------------------------------------
  pgm.sql(`
    CREATE OR REPLACE FUNCTION checkout_create(
      p_conversation_id uuid,
      p_visitor_token   uuid,
      p_items           jsonb,
      p_reference       text,
      p_provider        text
    )
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE
      v_conv       conversations%ROWTYPE;
      v_email      text;
      v_biz_name   text;
      v_item       jsonb;
      v_mat        materials%ROWTYPE;
      v_qty        integer;
      v_price      numeric(14,2);
      v_cur        text := NULL;
      v_line_cur   text;
      v_total      numeric(14,2) := 0;
      v_order_id   uuid;
      v_amount     bigint;
    BEGIN
      IF p_reference IS NULL OR p_reference !~ '^[A-Za-z0-9_-]{10,100}$' THEN
        RAISE EXCEPTION 'invalid payment reference';
      END IF;
      IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
         OR jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 50 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid_items');
      END IF;

      SELECT * INTO v_conv FROM conversations c
      WHERE c.id = p_conversation_id AND c.kind = 'consumer' AND c.visitor_token = p_visitor_token;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'conversation_not_found');
      END IF;
      IF v_conv.counterparty_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_identified');
      END IF;

      SELECT cp.contact->>'email' INTO v_email FROM counterparties cp WHERE cp.id = v_conv.counterparty_id;
      IF v_email IS NULL OR length(btrim(v_email)) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_identified');
      END IF;

      SELECT b.name INTO v_biz_name FROM businesses b WHERE b.id = v_conv.business_id;

      -- Pass 1: validate every line and total it in numeric arithmetic.
      FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
        IF (v_item->>'quantity') IS NULL OR (v_item->>'quantity') !~ '^[0-9]{1,3}$'
           OR (v_item->>'material_id') IS NULL OR (v_item->>'material_id') !~ '^[0-9a-fA-F-]{36}$' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'invalid_items');
        END IF;
        v_qty := (v_item->>'quantity')::integer;
        IF v_qty < 1 OR v_qty > 100 THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'invalid_items');
        END IF;

        SELECT * INTO v_mat FROM materials m
        WHERE m.id = (v_item->>'material_id')::uuid
          AND m.business_id = v_conv.business_id
          AND m.catalog_meta IS NOT NULL;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'item_unavailable');
        END IF;
        IF (v_mat.catalog_meta->>'price') IS NULL
           OR (v_mat.catalog_meta->>'price') !~ '^[0-9]{1,9}(\\.[0-9]{1,2})?$' THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'item_unavailable');
        END IF;
        v_price := (v_mat.catalog_meta->>'price')::numeric;
        IF v_price <= 0 THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'item_unavailable');
        END IF;

        v_line_cur := upper(COALESCE(v_mat.catalog_meta->>'currency', 'GHS'));
        IF v_cur IS NULL THEN
          v_cur := v_line_cur;
        ELSIF v_cur <> v_line_cur THEN
          RETURN jsonb_build_object('ok', false, 'reason', 'mixed_currency');
        END IF;

        v_total := v_total + round(v_price * v_qty, 2);
      END LOOP;

      IF v_total <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid_items');
      END IF;

      -- Pass 2: write the order, its lines and the payment.
      INSERT INTO orders (business_id, counterparty_id, direction, status, total, metadata)
      VALUES (v_conv.business_id, v_conv.counterparty_id, 'sale', 'pending_payment', v_total,
              jsonb_build_object('source', 'checkout', 'conversation_id', v_conv.id))
      RETURNING id INTO v_order_id;

      FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
        v_qty := (v_item->>'quantity')::integer;
        SELECT * INTO v_mat FROM materials m WHERE m.id = (v_item->>'material_id')::uuid;
        INSERT INTO order_items (order_id, material_id, quantity, unit_price)
        VALUES (v_order_id, v_mat.id, v_qty, (v_mat.catalog_meta->>'price')::numeric);
      END LOOP;

      v_amount := (v_total * 100)::bigint;

      INSERT INTO payments (order_id, business_id, conversation_id, provider, reference,
                            amount_minor, currency, checkout_email)
      VALUES (v_order_id, v_conv.business_id, v_conv.id, p_provider, p_reference,
              v_amount, v_cur, btrim(v_email));

      RETURN jsonb_build_object(
        'ok', true,
        'order_id', v_order_id,
        'reference', p_reference,
        'amount_minor', v_amount,
        'currency', v_cur,
        'email', btrim(v_email),
        'business_name', v_biz_name
      );
    END;
    $$;
  `);

  // ------------------------------------------------------------------
  // payment_apply_event — the ONLY way a payment becomes 'paid'.
  // p_status is the provider's own outcome mapped by the caller to one of
  // 'success' | 'failed' | 'abandoned' | 'other'.
  // ------------------------------------------------------------------
  pgm.sql(`
    CREATE OR REPLACE FUNCTION payment_apply_event(
      p_provider         text,
      p_event_key        text,
      p_event_type       text,
      p_reference        text,
      p_status           text,
      p_amount_minor     bigint,
      p_currency         text,
      p_provider_txn_id  text,
      p_payload          jsonb
    )
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE
      v_rows     integer;
      v_pay      payments%ROWTYPE;
      v_biz_name text;
    BEGIN
      INSERT INTO payment_events (provider, event_key, event_type, reference, payload)
      VALUES (p_provider, p_event_key, p_event_type, p_reference, COALESCE(p_payload, '{}'::jsonb))
      ON CONFLICT (provider, event_key) DO NOTHING;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 0 THEN
        RETURN jsonb_build_object('applied', false, 'reason', 'duplicate_event');
      END IF;

      SELECT * INTO v_pay FROM payments p
      WHERE p.reference = p_reference AND p.provider = p_provider
      FOR UPDATE;
      IF NOT FOUND THEN
        UPDATE payment_events SET outcome = 'unknown_reference'
        WHERE provider = p_provider AND event_key = p_event_key;
        RETURN jsonb_build_object('applied', false, 'reason', 'unknown_reference');
      END IF;

      IF p_status = 'success' THEN
        IF v_pay.amount_minor <> p_amount_minor OR v_pay.currency <> upper(COALESCE(p_currency, '')) THEN
          UPDATE payment_events SET outcome = 'amount_or_currency_mismatch'
          WHERE provider = p_provider AND event_key = p_event_key;
          RETURN jsonb_build_object('applied', false, 'reason', 'amount_mismatch');
        END IF;
        IF v_pay.status = 'paid' THEN
          UPDATE payment_events SET outcome = 'already_paid'
          WHERE provider = p_provider AND event_key = p_event_key;
          RETURN jsonb_build_object('applied', false, 'reason', 'already_paid');
        END IF;

        UPDATE payments
        SET status = 'paid', paid_at = now(), provider_transaction_id = p_provider_txn_id, updated_at = now()
        WHERE id = v_pay.id;
        UPDATE orders SET status = 'paid' WHERE id = v_pay.order_id;

        -- The token the visitor hands to the chat to reach a human.
        INSERT INTO transaction_tokens (order_id, counterparty_id)
        SELECT o.id, o.counterparty_id FROM orders o
        WHERE o.id = v_pay.order_id
          AND NOT EXISTS (SELECT 1 FROM transaction_tokens t WHERE t.order_id = o.id);

        SELECT b.name INTO v_biz_name FROM businesses b WHERE b.id = v_pay.business_id;
        INSERT INTO notifications (business_id, person_id, kind, order_id, title, body)
        SELECT v_pay.business_id, p.id, 'payment_received', v_pay.order_id,
               'Payment received',
               'An order at ' || v_biz_name || ' was paid: ' || v_pay.currency || ' '
                 || to_char(v_pay.amount_minor / 100.0, 'FM999999990.00')
        FROM people p
        JOIN businesses b ON b.holding_company_id = p.holding_company_id
        WHERE b.id = v_pay.business_id AND p.role = 'owner';

        UPDATE payment_events SET outcome = 'applied_paid'
        WHERE provider = p_provider AND event_key = p_event_key;
        RETURN jsonb_build_object('applied', true, 'reason', NULL, 'order_id', v_pay.order_id);
      END IF;

      IF p_status IN ('failed', 'abandoned') AND v_pay.status = 'initialized' THEN
        UPDATE payments SET status = p_status, updated_at = now() WHERE id = v_pay.id;
        UPDATE payment_events SET outcome = 'applied_' || p_status
        WHERE provider = p_provider AND event_key = p_event_key;
        RETURN jsonb_build_object('applied', true, 'reason', NULL, 'order_id', v_pay.order_id);
      END IF;

      UPDATE payment_events SET outcome = 'ignored'
      WHERE provider = p_provider AND event_key = p_event_key;
      RETURN jsonb_build_object('applied', false, 'reason', 'ignored');
    END;
    $$;
  `);

  // ------------------------------------------------------------------
  // payment_visitor_view — what the visitor who started this checkout may
  // see. The transaction token is released only once status = 'paid'.
  // ------------------------------------------------------------------
  pgm.sql(`
    CREATE OR REPLACE FUNCTION payment_visitor_view(p_reference text, p_visitor_token uuid)
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE
      v_pay   payments%ROWTYPE;
      v_token uuid;
    BEGIN
      SELECT p.* INTO v_pay
      FROM payments p
      JOIN conversations c ON c.id = p.conversation_id
      WHERE p.reference = p_reference
        AND c.kind = 'consumer'
        AND c.visitor_token = p_visitor_token;
      IF NOT FOUND THEN
        RETURN NULL;
      END IF;

      IF v_pay.status = 'paid' THEN
        SELECT t.token INTO v_token FROM transaction_tokens t
        WHERE t.order_id = v_pay.order_id AND t.redeemed_at IS NULL
        ORDER BY t.created_at ASC LIMIT 1;
      END IF;

      RETURN jsonb_build_object(
        'status', v_pay.status,
        'provider', v_pay.provider,
        'order_id', v_pay.order_id,
        'conversation_id', v_pay.conversation_id,
        'amount_minor', v_pay.amount_minor,
        'currency', v_pay.currency,
        'transaction_token', v_token
      );
    END;
    $$;
  `);

  const publicFns = [
    'checkout_create(uuid, uuid, jsonb, text, text)',
    'payment_apply_event(text, text, text, text, text, bigint, text, text, jsonb)',
    'payment_visitor_view(text, uuid)',
  ];
  for (const fn of publicFns) {
    pgm.sql(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`);
    pgm.sql(`GRANT EXECUTE ON FUNCTION ${fn} TO app_public;`);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DROP FUNCTION IF EXISTS payment_visitor_view(text, uuid);`);
  pgm.sql(`DROP FUNCTION IF EXISTS payment_apply_event(text, text, text, text, text, bigint, text, text, jsonb);`);
  pgm.sql(`DROP FUNCTION IF EXISTS checkout_create(uuid, uuid, jsonb, text, text);`);
  pgm.sql(`DROP TABLE IF EXISTS payment_events;`);
  pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON payments;`);
  pgm.sql(`REVOKE ALL ON payments FROM app_owner_partner, app_worker;`);
  pgm.sql(`DROP TABLE IF EXISTS payments;`);
};
