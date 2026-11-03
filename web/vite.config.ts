import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.PARALLAX_API ?? 'http://localhost:8790';
export default defineConfig({
  plugins: [react()],
  server: { port: 5190, proxy: { '/api': api, '/sites': api } },
});
