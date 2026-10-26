import  pg from 'pg';
const {Pool} = pg;
import dotenv from 'dotenv';

dotenv.config();

const dbUrl = process.env.DATABASE_URL || '';
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