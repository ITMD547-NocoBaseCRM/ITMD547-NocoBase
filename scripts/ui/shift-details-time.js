function JsReadonlyField() {
  const React = ctx.React;
  const { prefix, suffix, overflowMode } = ctx.model?.props || {};
  const whiteSpace = overflowMode === 'wrap' ? 'pre-line' : 'nowrap';
  const value = ctx.value;

  const formatTime = (input) => {
    if (!input) return '';
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) return String(input);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  };

  return (
    <span style={{ whiteSpace }}>
      {prefix}
      {formatTime(value)}
      {suffix}
    </span>
  );
}

ctx.render(<JsReadonlyField />);
