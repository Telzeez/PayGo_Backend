import app from './app.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import pool from './db.js';
import './mqtt-client.js';  // Auto-connects when imported

dotenv.config();

import { fileURLToPath } from 'url';

// Auto-initialize DB schema on startup
const initDb = async () => {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(process.cwd(), 'src', 'init-db.sql'),
      path.join(process.cwd(), 'backend', 'src', 'init-db.sql'),
      path.join(__dirname, 'init-db.sql'),
      path.join(__dirname, '..', 'src', 'init-db.sql'),
      path.join(process.cwd(), 'init-db.sql'),
    ];

    const sqlPath = candidates.find((p) => fs.existsSync(p));
    if (sqlPath) {
      const sql = fs.readFileSync(sqlPath, 'utf8');
      await pool.query(sql);
      console.log(`Database tables initialized successfully from ${sqlPath}`);
    } else {
      console.warn('Warning: init-db.sql was not found in candidate locations.');
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

