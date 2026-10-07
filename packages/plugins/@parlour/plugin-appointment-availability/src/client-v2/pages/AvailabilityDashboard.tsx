import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Checkbox, Col, DatePicker, Drawer, Form, Input, InputNumber, List, Modal, Row, Select, Space, Spin, Table, Tabs, Tag, TimePicker, Typography } from 'antd';
import dayjs from 'dayjs';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';

type RecordItem = Record<string, any>;
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dataOf = (response: any) => response?.data?.data || response?.data || [];
const errorMessage = (error: any) => error?.response?.data?.errors?.[0]?.message || error?.response?.data?.message || 'Unable to complete this request. Please try again.';
const toPeriods = (values: any) => (values.periods || []).map((period: any) => ({ start: period.start?.format?.('HH:mm') || period.start, end: period.end?.format?.('HH:mm') || period.end })).filter((period: any) => period.start && period.end);

export default function AvailabilityDashboard() {
  const ctx = useFlowContext();
  const t = useT();
  const [staff, setStaff] = useState<RecordItem[]>([]);
  const [schedules, setSchedules] = useState<RecordItem[]>([]);
  const [overrides, setOverrides] = useState<RecordItem[]>([]);
  const [leaves, setLeaves] = useState<RecordItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<'schedule' | 'override' | 'leave' | null>(null);
  const [saving, setSaving] = useState(false);
  // Appointments that a new leave period would strand, and who covers each one.
  const [cover, setCover] = useState<{ items: RecordItem[]; choices: Record<string, any> } | null>(null);
  const [form] = Form.useForm();

  const staffOptions = useMemo(() => staff.map((item) => ({ value: item.id, label: [item.firstName, item.lastName].filter(Boolean).join(' ') || 'Unnamed staff member' })), [staff]);
  const staffLabel = (id: any) => staffOptions.find((item) => String(item.value) === String(id))?.label || 'Unknown staff member';
  const load = async () => {
    setLoading(true); setError('');
    try {
      const [staffResult, scheduleResult, overrideResult, leaveResult] = await Promise.all([
        ctx.api.request({ url: 'staff:list', method: 'get', params: { fields: ['id', 'firstName', 'lastName'], pageSize: 200 } }),
        ctx.api.request({ url: 'staffAvailabilitySchedules:list', method: 'get', params: { pageSize: 200, sort: ['weekday', '-effectiveFrom'] } }),
        ctx.api.request({ url: 'staffAvailabilityOverrides:list', method: 'get', params: { pageSize: 200, sort: ['-date'] } }),
        ctx.api.request({ url: 'staffAvailabilityLeaves:list', method: 'get', params: { pageSize: 200, sort: ['startTime'] } }),
      ]);
      setStaff(dataOf(staffResult)); setSchedules(dataOf(scheduleResult)); setOverrides(dataOf(overrideResult)); setLeaves(dataOf(leaveResult));
    } catch (requestError) { setError(errorMessage(requestError)); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // Opened from a drag on the shift calendar: ?start=...&end=... pre-fills a new recurring schedule.
  const slotHandled = React.useRef(false);
  useEffect(() => {
    if (loading || slotHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const startParam = params.get('start');
    if (!startParam) return;
    slotHandled.current = true;
    // The calendar sends the dragged wall-clock time with a "Z" suffix; keep the clock reading as-is
    // instead of shifting it by the browser's offset.
    const wallClock = (value: string) => dayjs(value.replace(/(\.\d+)?Z$/, ''));
    const start = wallClock(startParam);
    if (!start.isValid()) return;
    const endParam = params.get('end');
    const end = endParam ? wallClock(endParam) : start.add(1, 'hour');
    // A month-view click or all-day slot has no useful times: fall back to a normal working day.
    const dayOnly = start.hour() === 0 && start.minute() === 0 && (!end.isValid() || !end.isAfter(start) || end.diff(start, 'hour') >= 23);
    const from = dayOnly ? start.hour(9).minute(0) : start;
    const to = dayOnly ? start.hour(17).minute(0) : (end.isValid() && end.isAfter(start) ? end : start.add(1, 'hour'));
    // Applied once the drawer is open (see the effect below): values set before its form mounts are lost.
    slotValues.current = { isWorking: true, weekdays: [start.day()], effectiveFrom: start.startOf('day'), periods: [{ start: from, end: to }] };
    setEditor('schedule');
  }, [loading]);
  const slotValues = React.useRef<RecordItem | null>(null);
  useEffect(() => {
    if (editor !== 'schedule' || !slotValues.current) return;
    const apply = () => { if (slotValues.current) { form.resetFields(); form.setFieldsValue(slotValues.current); } };
    const timer = window.setTimeout(apply, 150);
    // If the drawer's fields mounted late and dropped the values, apply them once more before giving up.
    const retry = window.setTimeout(() => { if (!(form.getFieldValue('weekdays') || []).length) apply(); slotValues.current = null; }, 600);
    return () => { window.clearTimeout(timer); window.clearTimeout(retry); };
  }, [editor]);

  const openEditor = (kind: 'schedule' | 'override' | 'leave') => {
    form.resetFields();
    if (kind !== 'leave') form.setFieldsValue({ isWorking: true, periods: [{ start: dayjs('09:00', 'HH:mm'), end: dayjs('17:00', 'HH:mm') }] });
    setEditor(kind);
  };
  const save = async () => {
    const values = await form.validateFields();
    const resource = editor === 'schedule' ? 'staffAvailabilitySchedules' : editor === 'override' ? 'staffAvailabilityOverrides' : 'staffAvailabilityLeaves';
    const payload: RecordItem = { ...values };
    if (editor === 'schedule') { payload.effectiveFrom = values.effectiveFrom.format('YYYY-MM-DD'); payload.effectiveTo = values.effectiveTo?.format('YYYY-MM-DD'); payload.periods = toPeriods(values); }
    if (editor === 'override') { payload.date = values.date.format('YYYY-MM-DD'); payload.periods = values.isWorking ? toPeriods(values) : []; }
    if (editor === 'leave') { payload.startTime = values.range[0].toISOString(); payload.endTime = values.range[1].toISOString(); delete payload.range; }
    setSaving(true);
    try {
      if (editor === 'leave') {
        const response = await ctx.api.request({ url: 'appointmentAvailability:leaveConflicts', method: 'post', data: { staffId: payload.staffId, startTime: payload.startTime, endTime: payload.endTime } });
        const items = dataOf(response).appointments || [];
        if (items.length) {
          setCover({ items, choices: Object.fromEntries(items.map((item: RecordItem) => [String(item.id), item.candidates?.[0]?.id])) });
          pendingLeave.current = payload;
          setSaving(false);
          return;
        }
      }
      if (editor === 'schedule') {
        const weekdays = values.weekdays as number[];
        delete payload.weekdays;
        for (const weekday of weekdays) await ctx.api.request({ url: `${resource}:create`, method: 'post', data: { ...payload, weekday } });
      } else {
        await ctx.api.request({ url: `${resource}:create`, method: 'post', data: payload });
      }
      ctx.message.success(t('Saved successfully')); setEditor(null); await load();
    }
    catch (requestError) { ctx.message.error(errorMessage(requestError)); } finally { setSaving(false); }
  };
  const pendingLeave = React.useRef<RecordItem | null>(null);
  const confirmCover = async () => {
    if (!cover || !pendingLeave.current) return;
    if (cover.items.some((item) => !cover.choices[String(item.id)])) return;
    setSaving(true);
    try {
      // Move the appointments first: the leave is rejected while they are still booked on this staff member.
      for (const item of cover.items) await ctx.api.request({ url: 'appointments:update', method: 'post', params: { filterByTk: item.id }, data: { staffId: cover.choices[String(item.id)] } });
      await ctx.api.request({ url: 'staffAvailabilityLeaves:create', method: 'post', data: pendingLeave.current });
      ctx.message.success(t('Leave saved and appointments reassigned')); setCover(null); setEditor(null); pendingLeave.current = null; await load();
    } catch (requestError) { ctx.message.error(errorMessage(requestError)); } finally { setSaving(false); }
  };
  const remove = async (resource: string, id: any) => { try { await ctx.api.request({ url: `${resource}:destroy`, method: 'post', data: { filterByTk: id } }); await load(); } catch (requestError) { ctx.message.error(errorMessage(requestError)); } };

  const scheduleColumns = [
    { title: t('Staff'), render: (item: RecordItem) => staffLabel(item.staffId) },
    { title: t('Day'), dataIndex: 'weekday', render: (value: number) => weekdays[value] || '—' },
    { title: t('Effective dates'), render: (item: RecordItem) => `${item.effectiveFrom}${item.effectiveTo ? ` – ${item.effectiveTo}` : ' onward'}` },
    { title: t('Hours'), render: (item: RecordItem) => item.isWorking ? (item.periods || []).map((p: any) => `${p.start}–${p.end}`).join(', ') || 'No periods' : <Tag>Day off</Tag> },
    { title: t('Actions'), render: (item: RecordItem) => <Button type="link" danger onClick={() => remove('staffAvailabilitySchedules', item.id)}>{t('Delete')}</Button> },
  ];
  const overrideColumns = [
    { title: t('Date'), dataIndex: 'date' }, { title: t('Staff'), render: (item: RecordItem) => staffLabel(item.staffId) },
    { title: t('Availability'), render: (item: RecordItem) => item.isWorking ? (item.periods || []).map((p: any) => `${p.start}–${p.end}`).join(', ') : <Tag color="default">Unavailable</Tag> },
    { title: t('Reason'), dataIndex: 'reason', render: (value: string) => value || '—' },
    { title: t('Actions'), render: (item: RecordItem) => <Button type="link" danger onClick={() => remove('staffAvailabilityOverrides', item.id)}>{t('Delete')}</Button> },
  ];
  const leaveColumns = [
    { title: t('Staff'), render: (item: RecordItem) => staffLabel(item.staffId) }, { title: t('From'), dataIndex: 'startTime', render: (value: string) => dayjs(value).format('MMM D, YYYY h:mm A') },
    { title: t('To'), dataIndex: 'endTime', render: (value: string) => dayjs(value).format('MMM D, YYYY h:mm A') }, { title: t('Reason'), dataIndex: 'reason', render: (value: string) => value || '—' },
    { title: t('Actions'), render: (item: RecordItem) => <Button type="link" danger onClick={() => remove('staffAvailabilityLeaves', item.id)}>{t('Delete')}</Button> },
  ];

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}><Spin size="large" /></div>;
  return <div style={{ maxWidth: 1200, margin: '0 auto', padding: '16px clamp(12px, 3vw, 32px)' }}>
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div><Typography.Title level={2} style={{ marginBottom: 4 }}>{t('Staff availability')}</Typography.Title><Typography.Text type="secondary">{t('Manage working hours, exceptions, and time away before booking appointments.')}</Typography.Text></div>
      {error && <Alert type="error" showIcon message={error} action={<Button size="small" onClick={load}>{t('Retry')}</Button>} />}
      <AvailabilityLookup staffOptions={staffOptions} />
      <Card>
        <Tabs items={[
          { key: 'schedules', label: t('Recurring schedules'), children: <><Button type="primary" onClick={() => openEditor('schedule')} style={{ marginBottom: 16 }}>{t('Add schedule')}</Button><Table rowKey="id" columns={scheduleColumns} dataSource={schedules} pagination={{ pageSize: 10 }} scroll={{ x: 720 }} /></> },
          { key: 'overrides', label: t('Date overrides'), children: <><Button type="primary" onClick={() => openEditor('override')} style={{ marginBottom: 16 }}>{t('Add override')}</Button><Table rowKey="id" columns={overrideColumns} dataSource={overrides} pagination={{ pageSize: 10 }} scroll={{ x: 720 }} /></> },
          { key: 'leave', label: t('Leave'), children: <><Button type="primary" onClick={() => openEditor('leave')} style={{ marginBottom: 16 }}>{t('Add leave')}</Button><Table rowKey="id" columns={leaveColumns} dataSource={leaves} pagination={{ pageSize: 10 }} scroll={{ x: 720 }} /></> },
        ]} />
      </Card>
    </Space>
    <Modal open={!!cover} title={t('Reassign appointments before leave')} okText={t('Reassign and save leave')} cancelText={t('Cancel')} confirmLoading={saving}
      okButtonProps={{ disabled: !cover || cover.items.some((item) => !cover.choices[String(item.id)]) }} onOk={confirmCover} onCancel={() => { setCover(null); pendingLeave.current = null; }} width={640}>
      <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={t('This staff member has appointments during the leave. Choose who covers each one.')} />
      <List dataSource={cover?.items || []} renderItem={(item: RecordItem) => <List.Item>
        <Space direction="vertical" style={{ width: '100%' }} size={4}>
          <Typography.Text strong>{item.customerName} · {dayjs(item.startTime).format('MMM D, h:mm A')} – {dayjs(item.endTime).format('h:mm A')}</Typography.Text>
          {item.candidates?.length
            ? <Select style={{ width: '100%' }} value={cover?.choices[String(item.id)]} onChange={(value) => setCover((current) => current && ({ ...current, choices: { ...current.choices, [String(item.id)]: value } }))} options={item.candidates.map((candidate: RecordItem) => ({ value: candidate.id, label: candidate.name }))} />
            : <Alert type="error" showIcon message={t('No other staff member is free at this time. Reschedule or cancel this appointment first.')} />}
        </Space>
      </List.Item>} />
    </Modal>
    <Drawer title={editor === 'schedule' ? t('Recurring schedule') : editor === 'override' ? t('Date override') : t('Staff leave')} open={!!editor} onClose={() => setEditor(null)} width={480} forceRender destroyOnClose={false} footer={<Space><Button onClick={() => setEditor(null)}>{t('Cancel')}</Button><Button type="primary" loading={saving} onClick={save}>{t('Save')}</Button></Space>}>
      <Form form={form} layout="vertical">
        <Form.Item name="staffId" label={t('Staff')} rules={[{ required: true }]}><Select options={staffOptions} showSearch optionFilterProp="label" /></Form.Item>
        {editor === 'schedule' && <><Form.Item name="weekdays" label={t('Days')} rules={[{ required: true, type: 'array', min: 1 }]}><Checkbox.Group options={weekdays.map((label, value) => ({ label, value }))} style={{ display: 'flex', flexDirection: 'column', gap: 8 }} /></Form.Item><Row gutter={12}><Col span={12}><Form.Item name="effectiveFrom" label={t('Effective from')} rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item></Col><Col span={12}><Form.Item name="effectiveTo" label={t('Effective to')}><DatePicker style={{ width: '100%' }} /></Form.Item></Col></Row></>}
        {editor === 'override' && <Form.Item name="date" label={t('Date')} rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item>}
        {editor !== 'leave' && <><Form.Item name="isWorking" label={t('Working')} rules={[{ required: true }]}><Select options={[{ value: true, label: t('Available') }, { value: false, label: t('Day off') }]} /></Form.Item><Form.List name="periods">{(fields, { add, remove }) => <>{fields.map(({ key, ...field }) => <Row gutter={8} key={key}><Col span={10}><Form.Item {...field} name={[field.name, 'start']} rules={[{ required: true }]}><TimePicker format="HH:mm" minuteStep={15} style={{ width: '100%' }} /></Form.Item></Col><Col span={10}><Form.Item {...field} name={[field.name, 'end']} rules={[{ required: true }]}><TimePicker format="HH:mm" minuteStep={15} style={{ width: '100%' }} /></Form.Item></Col><Col span={4}><Button onClick={() => remove(field.name)} aria-label={t('Remove period')}>×</Button></Col></Row>)}<Button onClick={() => add()}>{t('Add period')}</Button></>}</Form.List></>}
        {editor === 'leave' && <Form.Item name="range" label={t('Leave period')} rules={[{ required: true }]}><DatePicker.RangePicker showTime style={{ width: '100%' }} /></Form.Item>}
        <Form.Item name="reason" label={t('Reason')}><Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} /></Form.Item>
      </Form>
    </Drawer>
  </div>;
}

function AvailabilityLookup({ staffOptions }: { staffOptions: Array<{ value: any; label: string }> }) {
  const ctx = useFlowContext(); const t = useT(); const [staffId, setStaffId] = useState<any>(); const [date, setDate] = useState<any>(dayjs()); const [durationMinutes, setDurationMinutes] = useState(60); const [slots, setSlots] = useState<any[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const search = async () => { if (!staffId || !date) { setError(t('Choose a staff member and date.')); return; } setLoading(true); setError(''); try { const response = await ctx.api.request({ url: 'appointmentAvailability:slots', method: 'post', data: { staffId, date: date.format('YYYY-MM-DD'), durationMinutes } }); setSlots(dataOf(response).slots || []); } catch (requestError) { setError(errorMessage(requestError)); setSlots([]); } finally { setLoading(false); } };
  return <Card title={t('Find appointment times')}><Row gutter={[12, 12]} align="bottom"><Col xs={24} sm={12} md={8}><Typography.Text>{t('Staff')}</Typography.Text><Select value={staffId} onChange={setStaffId} options={staffOptions} style={{ width: '100%', marginTop: 4 }} showSearch optionFilterProp="label" /></Col><Col xs={12} sm={6} md={5}><Typography.Text>{t('Date')}</Typography.Text><DatePicker value={date} onChange={setDate} style={{ width: '100%', marginTop: 4 }} /></Col><Col xs={12} sm={6} md={4}><Typography.Text>{t('Minutes')}</Typography.Text><InputNumber value={durationMinutes} onChange={(value) => setDurationMinutes(value || 60)} min={15} step={15} style={{ width: '100%', marginTop: 4 }} /></Col><Col xs={24} md={4}><Button type="primary" onClick={search} loading={loading} style={{ width: '100%' }}>{t('Show available times')}</Button></Col></Row>{error && <Alert style={{ marginTop: 16 }} type="warning" showIcon message={error} />}{slots.length > 0 && <List style={{ marginTop: 16 }} size="small" bordered dataSource={slots} renderItem={(slot) => <List.Item><Tag color="blue">{dayjs(slot.startTime).format('h:mm A')} – {dayjs(slot.endTime).format('h:mm A')}</Tag></List.Item>} />}{!loading && !error && slots.length === 0 && <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>{t('Choose a staff member and date to see appointment times.')}</Typography.Paragraph>}</Card>;
}
