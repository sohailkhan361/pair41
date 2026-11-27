// pair41 migrate and pair41 admin: server-side commands that talk to the database directly.
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createDb, dialectOf, postgresSchema, readDatabaseSsl, readDatabaseUrl } from '../store/db.ts';
import { migrateToLatest } from '../store/migrations.ts';
import { createUser, participantByName, regenerateToken } from '../services/auth.ts';
import { PairError } from '../services/errors.ts';

export async function runAdmin(command: 'migrate' | 'admin', args: string[]): Promise<number> {
  const url = readDatabaseUrl(process.env, command === 'migrate');
  const db = createDb(url, readDatabaseSsl(process.env));
  try {
    if (command === 'migrate') {
      const applied = await migrateToLatest(db, dialectOf(url), postgresSchema(url));
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
      return 0;
    }
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: { password: { type: 'string' } },
    });
    const [action, name] = positionals;
    if (action === 'add-user' && name) {
      const password = values.password ?? randomBytes(12).toString('base64url');
      const { participant, token } = await createUser(db, name, password);
      console.log(`Created user ${participant.name}.`);
      if (!values.password) console.log(`Password: ${password}`);
      console.log(`Agent token (shown once; put it in PAIR41_TOKEN): ${token}`);
      return 0;
    }
    if (action === 'new-token' && name) {
      const participant = await participantByName(db, name);
      if (!participant) throw new PairError(`No user called "${name}".`);
      const token = await regenerateToken(db, participant.id);
      console.log(`New agent token for ${participant.name} (the old one no longer works): ${token}`);
      return 0;
    }
    console.error('Usage: pair41 admin add-user <name> [--password <pw>] | pair41 admin new-token <name>');
    return 2;
  } catch (error) {
    if (error instanceof PairError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  } finally {
    await db.destroy();
  }
}
