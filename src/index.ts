import app from './app.js';
import dotenv from 'dotenv';
import './mqtt-client.js';  // Auto-connects when imported

dotenv.config();

const PORT: number = parseInt(process.env.PORT || '3001', 10);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

