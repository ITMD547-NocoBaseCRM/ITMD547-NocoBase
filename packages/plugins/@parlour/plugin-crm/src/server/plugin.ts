import { Plugin } from '@nocobase/server';
import sql from 'mssql';

export class PluginCrmServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {
    // Keep a month/day sort key (MMDD) so the customer list can be ordered by
    // upcoming birthday regardless of birth year.
    this.db.on('customers.beforeSave', (model: any) => {
      const dob = model.get('dateOfBirth');
      const match = typeof dob === 'string' ? dob.match(/^\d{4}-(\d{2})-(\d{2})/) : null;
      model.set('birthMonthDay', match ? Number(match[1] + match[2]) : null);
    });

    // Visits = completed appointments. Recount after the appointment commits so
    // we never query on a second pooled connection inside its transaction.
    const recount = (customerId: any, options: any) => {
      if (!customerId) return;
      const run = async () => {
        try {
          const count = await this.db.getRepository('appointments').count({ filter: { customerId, status: 'completed' } });
          await this.db.getRepository('customers').update({ filterByTk: customerId, values: { visitCount: count }, hooks: false });
        } catch (error) {
          this.app.logger.error(error);
        }
      };
      if (options?.transaction?.afterCommit) options.transaction.afterCommit(run);
      else run();
    };
    this.db.on('appointments.afterSave', (model: any, options: any) => {
      recount(model.get('customerId'), options);
      const previous = model.previous?.('customerId');
      if (previous && String(previous) !== String(model.get('customerId'))) recount(previous, options);
    });
    this.db.on('appointments.afterDestroy', (model: any, options: any) => recount(model.get('customerId'), options));
  }

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
