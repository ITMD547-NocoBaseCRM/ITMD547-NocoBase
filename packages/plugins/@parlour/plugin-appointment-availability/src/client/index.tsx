// Legacy client placeholder: the availability UI lives in client-v2. The legacy
// loader calls these lifecycle hooks on every plugin instance, so all must exist.
export default class PluginAppointmentAvailabilityLegacy {
  constructor(public options: any = {}, public app?: any) {}
  async afterAdd() {}
  async beforeLoad() {}
  async load() {}
  async afterEnable() {}
  async afterDisable() {}
  async remove() {}
}
