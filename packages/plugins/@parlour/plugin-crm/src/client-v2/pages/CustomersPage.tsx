import React, { useEffect, useState } from 'react';
import { Alert, Card, Spin, Table, Typography } from 'antd';
import { useFlowContext } from '@nocobase/flow-engine';

export default function CustomersPage() {
  const ctx = useFlowContext();

  const [customers, setCustomers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const loadCustomers = async () => {
      try {
        const response = await ctx.api.request({
          url: 'crmCustomers:list',
          method: 'get',
        });

        const data = response.data?.data ?? response.data;

console.log('Customers API response:', response.data);

setCustomers(Array.isArray(data) ? data : []);
      } catch (err: any) {
        console.error(err);
        setError(err?.message || 'Failed to load customers');
      } finally {
        setLoading(false);
      }
    };

    loadCustomers();
  }, []);

  const columns = [
    {
      title: 'First Name',
      dataIndex: 'FirstName',
    },
    {
      title: 'Last Name',
      dataIndex: 'LastName',
    },
    {
      title: 'Phone',
      dataIndex: 'Phone',
    },
    {
      title: 'Email',
      dataIndex: 'Email',
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Typography.Title level={2}>Customers</Typography.Title>

      {error && (
        <Alert
          type="error"
          message={error}
          style={{ marginBottom: 16 }}
        />
      )}

      <Card>
        {loading ? (
          <Spin />
        ) : (
          <Table
            rowKey="Id"
            columns={columns}
            dataSource={customers}
            pagination={false}
          />
        )}
      </Card>
    </div>
  );
}