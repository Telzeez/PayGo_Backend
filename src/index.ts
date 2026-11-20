import app from './app.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import pool from './db.js';
import './mqtt-client.js';
import { fileURLToPath } from 'url';

dotenv.config();

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
      await pool.query(fs.readFileSync(sqlPath, 'utf8'));
      console.log(`Database tables initialized successfully from ${sqlPath}`);
      // Apply Firebase identity before provisioning constraints so legacy
      // duplicate meter rows cannot block authentication schema setup.
      const migrationFiles = ['20261119_multi_device_metering.sql', '20261120_email_verification.sql', '20261122_firebase_identity.sql', '20261121_device_provisioning.sql'];
      for (const migrationFile of migrationFiles) {
        const migrationPath = path.join(path.dirname(sqlPath), 'migrations', migrationFile);
        if (!fs.existsSync(migrationPath)) continue;
        try {
          await pool.query(fs.readFileSync(migrationPath, 'utf8'));
          console.log(`PAYGO migration applied: ${migrationFile}`);
        } catch (migrationError) {
          console.error(`PAYGO migration failed: ${migrationFile}`, migrationError);
          // Keep independent migrations running; resolve failed constraints separately.
        }
      }
    } else {
      console.warn('Warning: init-db.sql was not found in candidate locations.');
    }
  } catch (err) {
    console.error('Error initializing database tables:', err);
  }
};

await initDb();
const PORT: number = parseInt(process.env.PORT || '3001', 10);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
