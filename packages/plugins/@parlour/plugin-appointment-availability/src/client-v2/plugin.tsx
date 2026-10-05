import { Application, Plugin } from '@nocobase/client-v2';

export class PluginAppointmentAvailabilityClientV2 extends Plugin<any, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({ key: 'appointment-availability', title: this.t('Appointment availability'), icon: 'CalendarOutlined' });
    this.pluginSettingsManager.addPageTabItem({ menuKey: 'appointment-availability', key: 'index', title: this.t('Staff availability'), componentLoader: () => import('./pages/AvailabilityDashboard') });
    this.router.add('appointment-availability', { path: '/appointment-availability', componentLoader: () => import('./pages/AvailabilityDashboard') });
  }
}

export default PluginAppointmentAvailabilityClientV2;
