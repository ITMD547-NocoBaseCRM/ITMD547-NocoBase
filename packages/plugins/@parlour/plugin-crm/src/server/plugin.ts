import { Plugin } from '@nocobase/server';
import sql from 'mssql';

export class PluginCrmServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    try {
      const pool = await sql.connect({
        server: process.env.AZURE_SQL_SERVER!,
        database: process.env.AZURE_SQL_DATABASE!,
        user: process.env.AZURE_SQL_USER!,
        password: process.env.AZURE_SQL_PASSWORD!,
        port: Number(process.env.AZURE_SQL_PORT || 1433),
        options: {
          encrypt: true,
          trustServerCertificate: false,
        },
      });

      const result = await pool.request().query('SELECT 1 AS connected');

      console.log('Azure SQL connected:', result.recordset);
    } catch (error) {
      console.error('Azure SQL connection failed:', error);
    }
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginCrmServer;