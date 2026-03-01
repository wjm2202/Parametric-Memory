/**
 * Global test setup — runs once before all test files.
 * Loads .env.test so every test module sees the correct process.env values.
 */
import dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '../../.env.test'), quiet: true });
