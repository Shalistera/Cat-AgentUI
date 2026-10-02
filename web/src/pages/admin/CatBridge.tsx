import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg } from '../../api';
import { Badge, Button, Card, ToggleRow, toast } from '../../components/ui';
import { useModels } from '../../store';

type Status = {
  paired: boolean;
  state: 'offline' | 'online' | 'busy';
  cliVersion: string | null;
  model: string | null;
  modelId: string | null;
  confirmWrites: boolean;
  error: string | null;
};
export default function CatBridge() {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const refresh = () =>
    api
      .get<Status>('/api/admin/catbridge')
      .then((s) => {
        setStatus(s);
        setError('');
      })
      .catch((e) => setError(errMsg(e)));
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, []);
  const pair = async () => {
    setSaving(true);
    try {
      const s = await api.post<Status & { token: string }>(
        '/api/admin/catbridge/pair',
        {},
      );
      setStatus(s);
      setToken(s.token);
      await useModels.getState().load(true);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setSaving(false);
    }
  };
  const revoke = async () => {
    setSaving(true);
    try {
      await api.del('/api/admin/catbridge/pair');
      setToken('');
      await refresh();
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-5 p-5 sm:p-6">
      <div>
        <h3 className="text-base font-semibold">CatBridge</h3>
        <p className="mt-1 text-sm text-tx2">
          连接你电脑上的 Claude Code，在面板中聊天和编辑工作区文件。
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-err">
          {error}
        </p>
      )}
      {status && (
        <>
          <Card className="space-y-4 p-5">
            <div className="flex items-center justify-between">
              <span className="font-medium">本机连接</span>
              <Badge tone={status.state === 'offline' ? 'err' : undefined}>
                {
                  { offline: '离线', online: '在线', busy: '正在处理回合' }[
                    status.state
                  ]
                }
              </Badge>
            </div>
            {status.model && (
              <p className="text-sm text-tx2">
                {status.cliVersion} · {status.model}
              </p>
            )}
            {status.error && <p className="text-sm text-tx2">{status.error}</p>}
            <p className="text-sm text-tx2">
              仅站点所有者账号可用，同时处理一个回合。电脑休眠或断网后，本次回复会中断。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={saving} onClick={pair}>
                {status.paired ? '更换配对凭证' : '生成配对凭证'}
              </Button>
              {status.paired && (
                <Button variant="ghost" disabled={saving} onClick={revoke}>
                  撤销配对
                </Button>
              )}
            </div>
            {status.paired && (
              <ToggleRow
                label="工作区写入前确认"
                desc="创建、修改、删除文件时，在对话中先确认。"
                checked={status.confirmWrites}
                onChange={async (value) => {
                  try {
                    setStatus(
                      await api.patch<Status>('/api/admin/catbridge', {
                        confirmWrites: value,
                      }),
                    );
                  } catch (e) {
                    toast(errMsg(e), 'err');
                  }
                }}
              />
            )}
          </Card>
          {token && (
            <Card className="space-y-3 p-5">
              <p className="font-medium">保存这次配对凭证</p>
              <p className="text-sm text-tx2">
                只显示一次。把它填入 CatBridge 的本地 .env 文件：
              </p>
              <pre className="overflow-x-auto rounded-lg bg-bg0 p-3 text-xs">
                CATBRIDGE_PANEL_TOKEN={token}
              </pre>
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      `CATBRIDGE_PANEL_TOKEN=${token}`,
                    );
                    toast('已复制');
                  } catch {
                    toast('请手动复制', 'err');
                  }
                }}
              >
                复制配置
              </Button>
              <Button variant="ghost" onClick={() => setToken('')}>
                收起凭证
              </Button>
            </Card>
          )}
          <Card className="space-y-3 p-5">
            <p className="font-medium">启动连接器</p>
            <ol className="list-inside list-decimal space-y-2 text-sm text-tx2">
              <li>在已登录 Claude Code 的电脑上，安装并构建 CatBridge。</li>
              <li>
                复制 catbridge.example.json 为 catbridge.local.json，把
                panel.url 设为 <code>{window.location.origin}</code>。
              </li>
              <li>
                在 CatBridge 目录运行 <code>npm start</code>，等待这里显示在线。
              </li>
              <li>新建对话，选择「Claude Code · CatBridge」。</li>
            </ol>
            <p className="text-sm text-tx3">
              首版支持文本及工作区的列出、读取、创建、修改和删除。图片、附件及其他工具后续接入。
            </p>
            <Link className="text-sm text-acc" to="/">
              返回聊天
            </Link>
          </Card>
        </>
      )}
    </div>
  );
}
