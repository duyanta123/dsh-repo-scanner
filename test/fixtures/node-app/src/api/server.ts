import express from 'express';
import { AuthService } from '../auth/service';
import { makeApp } from '@auth/service';

export async function startServer(): Promise<void> {
  const app = express();
  const svc = new AuthService();
  app.get('/health', (_req: unknown) => svc.login('ok'));
  app.listen(8080);
  const lazy = await import('../auth/service');
  console.log(lazy.AuthService);
}