import  pg from 'pg';
const {Pool} = pg;
import dotenv from 'dotenv';

dotenv.config();

let dbUrl = process.env.DATABASE_URL || '';

// Handle Render internal host across cross-region setups automatically
try {
  if (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://')) {
    const parsed = new URL(dbUrl);
    if (parsed.hostname.startsWith('dpg-') && !parsed.hostname.includes('.')) {
      parsed.hostname = `${parsed.hostname}.oregon-postgres.render.com`;
      dbUrl = parsed.toString();
    }
  }
} catch (e) {
  // If parsing fails, fall back to raw dbUrl
}

const isLocal = !dbUrl || dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');

const pool = new Pool({
    connectionString: dbUrl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: isLocal ? undefined : { rejectUnauthorized: false }
});

pool.on('connect', () => {
    console.log('Postgres connected');
});

pool.on("error", (err) => {
    console.error("Postgresql error: ", err);
});

export default pool;