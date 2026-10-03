import { Plugin } from '@nocobase/client';
import models from './models';

export class PluginAppointmentAvailabilityClient extends Plugin {
  async load() {
    this.flowEngine.registerModels(models);
  }
}

export default PluginAppointmentAvailabilityClient;
