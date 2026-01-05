import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './schema.ts',         // 对应你截图里的位置
  out: './drizzle/migrations',   // 自动生成的 SQL 存放处
  dialect: 'sqlite',
  driver: 'd1-http',
});