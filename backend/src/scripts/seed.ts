import 'dotenv/config';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';

/**
 * Seeds one holding company with one business and three people (owner,
 * partner, worker), a partnership linking the partner to that business,
 * and login credentials for all three. Prints the IDs and a ready-to-use
 * curl login command for each person at the end.
 *
 * Connects via DATABASE_URL (the admin/superuser connection used by
 * migrations), NOT APP_DATABASE_URL — seeding needs to write to
 * holding_companies/people/etc. without any tenant context existing yet,
 * the same bootstrapping situation described in
 * routes/holdingCompanies.ts's comment on why there's no POST route for
 * creating a holding company. This script is that bootstrapping path for
 * local development; see the README for the real-world equivalent.
 *
 * Idempotent-ish: re-running creates a second holding company with a new
 * name each time (suffixed with the current timestamp) rather than
 * failing on unique constraint violations, so `npm run seed` is safe to
 * run repeatedly during local development.
 */

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — see .env.example');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const suffix = new Date().toISOString();
    const hcResult = await client.query(
      `INSERT INTO holding_companies (name) VALUES ($1) RETURNING id, name`,
      [`Seed Holding Co ${suffix}`],
    );
    const holdingCompanyId = hcResult.rows[0].id;

    const businessResult = await client.query(
      `INSERT INTO businesses (holding_company_id, name) VALUES ($1, $2) RETURNING id, name`,
      [holdingCompanyId, 'Seed Coconut Products'],
    );
    const businessId = businessResult.rows[0].id;

    const people: Array<{ role: 'owner' | 'partner' | 'worker'; name: string; email: string }> = [
      { role: 'owner', name: 'Seed Owner', email: `owner+${Date.now()}@example.com` },
      { role: 'partner', name: 'Seed Partner', email: `partner+${Date.now()}@example.com` },
      { role: 'worker', name: 'Seed Worker', email: `worker+${Date.now()}@example.com` },
    ];

    const password = 'seed_password_123';
    const passwordHash = await bcrypt.hash(password, 10);

    const created: Array<{ id: string; role: string; email: string }> = [];

    for (const person of people) {
      const personResult = await client.query(
        `INSERT INTO people (holding_company_id, name, role, email)
         VALUES ($1, $2, $3, $4) RETURNING id, role, email`,
        [holdingCompanyId, person.name, person.role, person.email],
      );
      const row = personResult.rows[0];
      created.push(row);

      await client.query(
        `INSERT INTO credentials (person_id, password_hash) VALUES ($1, $2)`,
        [row.id, passwordHash],
      );

      if (person.role === 'partner') {
        await client.query(
          `INSERT INTO partnerships (business_id, person_id, ownership_pct, capital_contributed)
           VALUES ($1, $2, $3, $4)`,
          [businessId, row.id, 40.0, 10000.0],
        );
      }
    }

    await client.query('COMMIT');

    console.log('Seed complete.\n');
    console.log(`holdingCompanyId: ${holdingCompanyId}`);
    console.log(`businessId:       ${businessId}`);
    console.log(`password (all):   ${password}\n`);
    for (const p of created) {
      console.log(`${p.role.padEnd(8)} personId=${p.id}  email=${p.email}`);
    }
    console.log('\nExample login:');
    console.log(
      `curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' -d '${JSON.stringify(
        { email: created[0].email, password, holdingCompanyId },
      )}'`,
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
