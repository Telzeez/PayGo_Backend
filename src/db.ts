import  pg from 'pg';
const {Pool} = pg;
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000

})
pool.on('connect', () => {
    console.log('Postgres connected')
})
pool.on("error", (err)=> {
    console.error("Postresql error: ", err)
})

export default pool