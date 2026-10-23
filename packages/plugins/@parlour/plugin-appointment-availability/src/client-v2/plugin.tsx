import { Application, Plugin } from '@nocobase/client-v2';
import { Modal } from 'antd';

const LEAVE_OVERRIDE_HEADER = 'X-Availability-Leave-Override';

export class PluginAppointmentAvailabilityClientV2 extends Plugin<any, Application> {
  async load() {
    const api = this.app.apiClient as any;
    if (!api.__appointmentAvailabilityLeaveInterceptor) api.__appointmentAvailabilityLeaveInterceptor = api.axios.interceptors.request.use(async (config: any) => {
      const url = String(config.url || '');
      if (config.__skipShiftLeavePrompt || !/employeeShifts:(create|update)(?:\?|$)/.test(url)) return config;
      const values = config.data?.values || config.data || {};
      if (['cancelled', 'onLeave'].includes(values.status)) return config;

      let response;
      try {
        response = await api.request({
          url: 'appointmentAvailability:shiftLeaveConflict',
          method: 'post',
          data: values,
          skipNotify: true,
          __skipShiftLeavePrompt: true,
        });
      } catch {
        // The authoritative server validation still runs on submit.
        return config;
      }
      const conflict = response?.data?.data?.conflict || response?.data?.conflict;
      if (!conflict) return config;

      const approved = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: 'Staff member is on leave',
          content: conflict.message,
          okText: 'Create shift anyway',
          cancelText: 'Keep editing',
          okButtonProps: { danger: true },
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!approved) {
        const cancelled: any = new Error('Shift creation cancelled');
        cancelled.config = { ...config, skipNotify: true };
        throw cancelled;
      }
      if (config.headers?.set) config.headers.set(LEAVE_OVERRIDE_HEADER, 'true');
      else config.headers = { ...(config.headers || {}), [LEAVE_OVERRIDE_HEADER]: 'true' };
      return config;
    });

    this.pluginSettingsManager.addMenuItem({ key: 'appointment-availability', title: this.t('Appointment availability'), icon: 'CalendarOutlined' });
    this.pluginSettingsManager.addPageTabItem({ menuKey: 'appointment-availability', key: 'index', title: this.t('Staff availability'), componentLoader: () => import('./pages/AvailabilityDashboard') });
    this.router.add('appointment-availability', { path: '/appointment-availability', componentLoader: () => import('./pages/AvailabilityDashboard') });
  }
}

export default PluginAppointmentAvailabilityClientV2;
