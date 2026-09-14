import { Plugin } from '@nocobase/server';
import sql from 'mssql';

export class PluginCrmServer extends Plugin {
  async load() {
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

    console.log('Azure SQL connected');

    this.app.resourceManager.define({
      name: 'crmCustomers',
      actions: {
        async list(ctx) {
          const result = await pool.request().query(`
            SELECT
              Id,
              FirstName,
              LastName,
              Phone,
              Email,
              Notes,
              CreatedAt,
              UpdatedAt
            FROM Customers
            ORDER BY Id DESC
          `);

          ctx.body = result.recordset;
        },
      },
    });

    this.app.acl.allow('crmCustomers', 'list', 'loggedIn');
  }
}

export default PluginCrmServer;