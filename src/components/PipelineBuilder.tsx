import React, { useState } from 'react';
import { Clock, Key, CheckCircle2, AlertCircle } from 'lucide-react';
import { parseCSV } from '../utils/csvParser';
import { apiFetch } from '../utils/api';

export default function PipelineBuilder({ onDatasetLoaded }: { onDatasetLoaded?: (dataset: any) => void }) {
  const [provider, setProvider] = useState<'PostgreSQL' | 'Snowflake'>('PostgreSQL');
  const [connectionString, setConnectionString] = useState('');
  const [schedule, setSchedule] = useState('0 0 * * *');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('loading');
    setMessage('');

    try {
      const response = await apiFetch('/api/db-connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, connectionString, schedule })
      });

      const data = await response.json();
      if (response.ok) {
        setStatus('success');
        setMessage(data.message);
        
        if (data.data && data.data.length > 0 && onDatasetLoaded) {
          // Convert JSON to CSV so we reuse parser
          const keys = Object.keys(data.data[0]);
          const csvLines = [keys.join(',')];
          data.data.forEach((row: any) => {
            const line = keys.map(k => {
              const val = row[k];
              if (val === null || val === undefined) return '';
              const str = String(val);
              if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                return `"${str.replace(/"/g, '""')}"`;
              }
              return str;
            }).join(',');
            csvLines.push(line);
          });
          const csvString = csvLines.join('\n');
          const parsed = parseCSV(csvString, `${provider}_sync_${new Date().getTime()}.csv`);
          onDatasetLoaded(parsed);
        }
      } else {
        setStatus('error');
        setMessage(data.error || 'Connection failed.');
      }
    } catch (err: any) {
      setStatus('error');
      setMessage(err.message || String(err));
    }
  };

  return (
    <div className="card p-5 sm:p-6 w-full h-full flex flex-col">
      <div className="mb-5">
        <h3 className="card-title">Connect a database</h3>
        <p className="mt-1 text-sm text-label-2">Pull a table straight from your warehouse and keep it in sync.</p>
      </div>

      <form onSubmit={handleConnect} className="space-y-4 flex-1 flex flex-col">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="space-y-1.5">
            <label className="field-label">Provider</label>
            <div className="relative">
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as any)}
                className="input"
              >
                <option value="PostgreSQL">PostgreSQL</option>
                <option value="Snowflake">Snowflake</option>
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="field-label">Sync</label>
            <div className="relative flex items-center">
              <Clock className="w-4 h-4 text-label-3 absolute left-3" />
              <select
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                className="input pl-9"
              >
                <option value="*/15 * * * *">Every 15 minutes</option>
                <option value="0 * * * *">Hourly</option>
                <option value="0 0 * * *">Nightly</option>
              </select>
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="field-label">Connection string</label>
          <div className="relative flex items-center">
            <Key className="w-4 h-4 text-label-3 absolute left-3" />
            <input
              type="password"
              value={connectionString}
              onChange={(e) => setConnectionString(e.target.value)}
              placeholder="postgres://user:password@host:port/dbname"
              className="input pl-9"
              required
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={status === 'loading'}
          className="btn btn-secondary w-full"
        >
          {status === 'loading' ? 'Connecting…' : 'Connect'}
        </button>

        {status === 'success' && (
          <div className="flex items-start gap-2 bg-green/10 p-3 rounded-xl">
            <CheckCircle2 className="w-5 h-5 text-green shrink-0 mt-0.5" />
            <p className="text-sm text-green font-medium leading-relaxed">{message}</p>
          </div>
        )}

        {status === 'error' && (
          <div className="flex items-start gap-2 bg-red/10 p-3 rounded-xl">
            <AlertCircle className="w-5 h-5 text-red shrink-0 mt-0.5" />
            <p className="text-sm text-red font-medium leading-relaxed">{message}</p>
          </div>
        )}
      </form>
    </div>
  );
}
