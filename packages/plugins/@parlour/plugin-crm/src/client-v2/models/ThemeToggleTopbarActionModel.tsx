import { MoonOutlined, SunOutlined } from '@ant-design/icons';
import { TopbarActionModel, useGlobalTheme } from '@nocobase/client-v2';
import { App, Button, Tooltip } from 'antd';
import React, { useState } from 'react';

type ThemeItem = {
  id: number;
  config?: { name?: string };
};

function ThemeToggleButton({ model }: { model: ThemeToggleTopbarActionModel }) {
  const { isDarkTheme } = useGlobalTheme();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const nextThemeName = isDarkTheme ? 'BeautyWithin' : 'Dark';

  const switchTheme = async () => {
    setLoading(true);
    try {
      const response = await model.context.api.request({
        url: 'themeConfig:list',
        params: { sort: 'id', paginate: false },
      });
      const themes: ThemeItem[] = response?.data?.data || [];
      const target = themes.find((theme) => theme.config?.name === nextThemeName);
      if (!target) throw new Error(`${nextThemeName} theme is not available`);

      await model.context.api.resource('users').updateTheme({ values: { themeId: target.id } });
      window.location.reload();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Could not switch theme');
      setLoading(false);
    }
  };

  return (
    <Tooltip title={`Switch to ${nextThemeName}`}>
      <Button
        type="text"
        aria-label={`Switch to ${nextThemeName} theme`}
        data-testid={model.getTestId()}
        icon={isDarkTheme ? <SunOutlined /> : <MoonOutlined />}
        loading={loading}
        onClick={switchTheme}
        style={{ width: 46, height: 46, color: 'var(--nb-topbar-action-color)' }}
      />
    </Tooltip>
  );
}

export class ThemeToggleTopbarActionModel extends TopbarActionModel {
  actionId = 'beautywithin-theme-toggle';
  testId = 'beautywithin-theme-toggle';

  render() {
    return <ThemeToggleButton model={this} />;
  }
}

export default ThemeToggleTopbarActionModel;