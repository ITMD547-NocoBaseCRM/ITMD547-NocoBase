import { Plugin } from '@nocobase/server';
import sql from 'mssql';

export class PluginCrmServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    const server = process.env.AZURE_SQL_SERVER;
    const database = process.env.AZURE_SQL_DATABASE;
    const user = process.env.AZURE_SQL_USER;
    const password = process.env.AZURE_SQL_PASSWORD;
    if (!server || !database || !user || !password) {
      this.app.logger.info('CRM Azure SQL connector is not configured; skipping connection.');
      return;
    }
    try {
      const pool = await sql.connect({
        server,
        database,
        user,
        password,
        port: Number(process.env.AZURE_SQL_PORT || 1433),
        options: {
          encrypt: true,
          trustServerCertificate: false,
        },
      });

      const result = await pool.request().query('SELECT 1 AS connected');

      this.app.logger.info('CRM Azure SQL connection verified.', { rows: result.recordset.length });
    } catch (error) {
      this.app.logger.warn('CRM Azure SQL connection failed.', { error: error instanceof Error ? error.message : 'unknown error' });
    }
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginCrmServer;
