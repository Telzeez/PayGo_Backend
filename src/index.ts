import app from './app.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import pool from './db.js';
import './mqtt-client.js';  // Auto-connects when imported

dotenv.config();

// Auto-initialize DB schema on startup
const initDb = async () => {
  try {
    const sqlPath = path.join(process.cwd(), 'src', 'init-db.sql');
    if (fs.existsSync(sqlPath)) {
      const sql = fs.readFileSync(sqlPath, 'utf8');
      await pool.query(sql);
      console.log('Database tables initialized successfully');
    }
  } catch (err) {
    console.error('Error initializing database tables:', err);
  }
};

initDb();

const PORT: number = parseInt(process.env.PORT || '3001', 10);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

