// Editable time-only field for the shift calendar form. Values are stored as instants,
// while the input is presented in the salon's America/Chicago timezone.
function JsEditableField() {
  const React = ctx.React;
  const { Input } = ctx.antd;
  const [value, setValue] = React.useState(ctx.getValue?.() ?? '');

  React.useEffect(() => {
    const handler = (event) => setValue(event?.detail ?? '');
    ctx.element?.addEventListener('js-field:value-change', handler);
    return () => ctx.element?.removeEventListener('js-field:value-change', handler);
  }, []);

  const formatTime = (input) => {
    if (!input) return '';
    const source = input?.toDate instanceof Function ? input.toDate() : input;
    const date = source instanceof Date ? source : new Date(source);
    if (Number.isNaN(date.getTime())) return String(input);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  };

  const onChange = (event) => {
    const next = event?.target?.value ?? '';
    setValue(next);
    ctx.setValue?.(next);
  };

  const displayTime = formatTime(value);
  return <Input {...ctx.model.props} value={displayTime} onChange={onChange} />;
}

ctx.render(<JsEditableField />);
