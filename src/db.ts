import  pg from 'pg';
const {Pool} = pg;
import dotenv from 'dotenv';

dotenv.config();

const isAiven = process.env.DATABASE_URL && process.env.DATABASE_URL.indexOf('aivencloud.com') !== -1;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    ssl: isAiven ? { rejectUnauthorized: false } : undefined
})
pool.on('connect', () => {
    console.log('Postgres connected')
})
pool.on("error", (err)=> {
    console.error("Postresql error: ", err)
})

export default pool