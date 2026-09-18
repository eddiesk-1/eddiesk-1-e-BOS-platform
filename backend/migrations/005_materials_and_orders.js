/**
 * 005_materials_and_orders
 *
 * The physical/commercial layer: materials move through business_nodes via
 * material_flows (one raw material can be the input for many product lines
 * — see the contract note on material_flows), and counterparties/orders/
 * order_items cover both procurement (direction='purchase') and sales/export
 * (direction='sale') through one shared table rather than parallel PO and
 * SO tables.
 *
 * materials, counterparties, and orders carry business_id directly;
 * material_flows and order_items reach it via their parent
 * (business_nodes and orders respectively) since the contract doesn't put
 * business_id on those two tables.
 *
 * All five RLS policies below call is_business_visible_to_caller(uuid) —
 * the SECURITY DEFINER helper function created in migration 004 — rather
 * than each writing its own partnerships/holding_company_id check inline.
 * See the long comment above that function's definition in
 * 004_row_level_security.js for why: an earlier version of this project
 * had every table duplicate the same partnerships subquery, and having
 * businesses' and partnerships' policies each independently reference the
 * other produced an RLS recursion Postgres refuses to evaluate. Routing
 * everything through one function means the partner-visibility rule has
 * exactly one definition, and no other table's policy can accidentally
 * recreate that cycle.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE materials (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      name        text NOT NULL,
      stage       text NOT NULL CHECK (stage IN ('raw', 'wip', 'finished')),
      unit        text NOT NULL
    );
  `);
  pgm.sql(`CREATE INDEX idx_materials_business_id ON materials(business_id);`);

  pgm.sql(`
    CREATE TABLE material_flows (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_node_id  uuid NOT NULL REFERENCES business_nodes(id) ON DELETE CASCADE,
      material_id       uuid NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      direction         text NOT NULL CHECK (direction IN ('input', 'output')),
      quantity_per_unit numeric(14,4) NOT NULL CHECK (quantity_per_unit > 0)
    );
  `);
  pgm.sql(`CREATE INDEX idx_material_flows_business_node_id ON material_flows(business_node_id);`);
  pgm.sql(`CREATE INDEX idx_material_flows_material_id ON material_flows(material_id);`);
  // "One coconut -> VCO + desiccated + coir": the query this supports is
  // "every business_node that consumes material X as an input," which is
  // exactly (material_id, direction) — this composite index is what makes
  // that a lookup instead of a scan once a shared raw material fans out
  // into many product lines.
  pgm.sql(`CREATE INDEX idx_material_flows_material_direction ON material_flows(material_id, direction);`);

  pgm.sql(`
    CREATE TABLE counterparties (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      name        text NOT NULL,
      roles       text[] NOT NULL CHECK (roles <@ ARRAY['customer','supplier','buyer','lead']),
      contact     jsonb NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  pgm.sql(`CREATE INDEX idx_counterparties_business_id ON counterparties(business_id);`);
  // GIN index so "find every counterparty with role X" (e.g. all suppliers)
  // is an index lookup on the array, not a per-row scan.
  pgm.sql(`CREATE INDEX idx_counterparties_roles ON counterparties USING GIN (roles);`);

  pgm.sql(`
    CREATE TABLE orders (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      counterparty_id  uuid NOT NULL REFERENCES counterparties(id) ON DELETE RESTRICT,
      direction        text NOT NULL CHECK (direction IN ('sale', 'purchase')),
      status           text NOT NULL,
      total            numeric(14,2) NOT NULL CHECK (total >= 0),
      metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at       timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_orders_business_id ON orders(business_id);`);
  pgm.sql(`CREATE INDEX idx_orders_counterparty_id ON orders(counterparty_id);`);
  pgm.sql(`CREATE INDEX idx_orders_business_direction ON orders(business_id, direction);`);

  pgm.sql(`
    CREATE TABLE order_items (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      material_id  uuid NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
      quantity     numeric(14,4) NOT NULL CHECK (quantity > 0),
      unit_price   numeric(14,2) NOT NULL CHECK (unit_price >= 0)
    );
  `);
  pgm.sql(`CREATE INDEX idx_order_items_order_id ON order_items(order_id);`);
  pgm.sql(`CREATE INDEX idx_order_items_material_id ON order_items(material_id);`);

  // --- Grants: same split as migration 004. Workers get full CRUD on all
  // five of these; nothing here is ledger/allocation data.
  const newTables = ['materials', 'material_flows', 'counterparties', 'orders', 'order_items'];
  for (const table of newTables) {
    pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO app_owner_partner, app_worker;`);
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
  }

  // materials: business_id directly on the table.
  pgm.sql(`
    CREATE POLICY tenant_isolation ON materials
      USING (is_business_visible_to_caller(materials.business_id));
  `);

  // counterparties: business_id directly on the table.
  pgm.sql(`
    CREATE POLICY tenant_isolation ON counterparties
      USING (is_business_visible_to_caller(counterparties.business_id));
  `);

  // orders: business_id directly on the table.
  pgm.sql(`
    CREATE POLICY tenant_isolation ON orders
      USING (is_business_visible_to_caller(orders.business_id));
  `);

  // material_flows: no business_id column of its own — reach it via
  // business_nodes, then delegate.
  pgm.sql(`
    CREATE POLICY tenant_isolation ON material_flows
      USING (
        EXISTS (
          SELECT 1 FROM business_nodes bn
          WHERE bn.id = material_flows.business_node_id
            AND is_business_visible_to_caller(bn.business_id)
        )
      );
  `);

  // order_items: no business_id column of its own — reach it via orders,
  // then delegate.
  pgm.sql(`
    CREATE POLICY tenant_isolation ON order_items
      USING (
        EXISTS (
          SELECT 1 FROM orders o
          WHERE o.id = order_items.order_id
            AND is_business_visible_to_caller(o.business_id)
        )
      );
  `);
};

exports.down = (pgm) => {
  const newTables = ['order_items', 'orders', 'counterparties', 'material_flows', 'materials'];
  for (const table of newTables) {
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
  }
  pgm.sql(`DROP TABLE IF EXISTS order_items;`);
  pgm.sql(`DROP TABLE IF EXISTS orders;`);
  pgm.sql(`DROP TABLE IF EXISTS counterparties;`);
  pgm.sql(`DROP TABLE IF EXISTS material_flows;`);
  pgm.sql(`DROP TABLE IF EXISTS materials;`);
};
