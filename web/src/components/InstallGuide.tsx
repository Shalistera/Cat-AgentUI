import { Fragment, useEffect, useState, type ReactNode } from 'react';
import {
  ArrowUpRight, Check, CircleCheck, Compass, Copy, Ellipsis, EllipsisVertical, MonitorDown, Share, Smartphone,
  SquarePlus, X,
} from 'lucide-react';
import { Button, Modal, toast } from './ui';
import { CatMark } from './Logo';
import { useUi } from '../store';
import {
  inAppHost, installNudgeDue, iosSafariMajor, isIOS, isStandalone, runInstallPrompt, snoozeInstallNudge,
  useInstall, useInstallPlatform, type InstallPlatform,
} from '../pwa';
import { t } from '../i18n';

// ---------------------------------------------------------------------------
// 添加到桌面 — the step-by-step guide (dialog), the phone card, and the
// in-app-browser hint on the login page. Each platform gets the one path that
// works there: Android Chrome/Edge a real install button, iOS the Share-sheet
// steps, WeChat & co. "open in a browser first".
// ---------------------------------------------------------------------------

function Step({ n, icon, children }: { n: number; icon?: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-pri text-[11px] font-semibold text-prifg">{n}</span>
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-tx">{children}</div>
      {icon && (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-bg0 text-acc">{icon}</span>
      )}
    </li>
  );
}

/** Fill `{name}` slots of an already translated sentence with elements, so
    each language keeps its own word order around the inline buttons. */
function fillSlots(text: string, slots: Record<string, ReactNode>): ReactNode {
  return text.split(/\{(\w+)\}/).map((part, i) => (i % 2 ? <Fragment key={i}>{slots[part]}</Fragment> : part));
}

/** A button the person has to find on their own screen, drawn inline. */
function Key({ children }: { children: ReactNode }) {
  return <span className="mx-0.5 inline-flex items-center gap-1 rounded-sm border border-line2 bg-bg2 px-1.5 py-px text-[12px] font-medium text-tx">{children}</span>;
}

function Benefits({ desktop }: { desktop?: boolean }) {
  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg bg-bg0 p-3">
      <CatMark size={40} />
      <p className="min-w-0 text-xs leading-relaxed text-tx2">
        {desktop
          ? t('独立窗口打开,不和其他网页标签混在一起;任务栏 / 程序坞图标上会显示完成数量。')
          : t('从桌面图标一点就开,全屏显示,不用在浏览器标签里找。')}
      </p>
    </div>
  );
}

function IosSteps({ safari }: { safari: boolean }) {
  const share = <Key><Share size={12} />{t('分享')}</Key>;
  const addHome = <Key>{t('添加到主屏幕')}</Key>;
  const add = <Key>{t('添加')}</Key>;
  if (!safari) {
    return (
      <ol className="space-y-3">
        <Step n={1} icon={<Share size={16} />}>{fillSlots(t('点浏览器里的{share}按钮(找不到的话,换 Safari 打开本页)'), { share })}</Step>
        <Step n={2} icon={<SquarePlus size={16} />}>{fillSlots(t('选{add}'), { add: addHome })}</Step>
        <Step n={3}>{fillSlots(t('点右上角{add}'), { add })}</Step>
      </ol>
    );
  }
  // iOS 26 tucked Share into the ··· menu of the default (compact) tab bar.
  const major = iosSafariMajor();
  if (major === 0 || major >= 26) {
    return (
      <ol className="space-y-3">
        <Step n={1} icon={<Ellipsis size={16} />}>
          {fillSlots(t('点地址栏旁边的{more}(工具栏上直接有分享按钮的话跳过这步)'), { more: <Key><Ellipsis size={12} /></Key> })}
        </Step>
        <Step n={2} icon={<Share size={16} />}>{fillSlots(t('点{share}'), { share })}</Step>
        <Step n={3} icon={<SquarePlus size={16} />}>{fillSlots(t('往下滑,点{add}'), { add: addHome })}</Step>
        <Step n={4}>{fillSlots(t('确认「作为网页 App 打开」是打开的,点右上角{add}'), { add })}</Step>
      </ol>
    );
  }
  return (
    <ol className="space-y-3">
      <Step n={1} icon={<Share size={16} />}>{fillSlots(t('点{share}按钮(iPhone 在屏幕底部,iPad 在右上角)'), { share })}</Step>
      <Step n={2} icon={<SquarePlus size={16} />}>{fillSlots(t('往下滑,点{add}'), { add: addHome })}</Step>
      <Step n={3}>{fillSlots(t('点右上角{add}'), { add })}</Step>
    </ol>
  );
}

function inAppName(): string {
  switch (inAppHost()) {
    case 'wechat': return t('微信');
    case 'wecom': return t('企业微信');
    case 'qq': return 'QQ';
    case 'dingtalk': return t('钉钉');
    case 'feishu': return t('飞书');
    case 'weibo': return t('微博');
    default: return t('当前 App');
  }
}

function InAppSteps() {
  return (
    <>
      <p className="mb-3 text-[13px] leading-relaxed text-tx2">
        {t('「{app}」里打开的网页不能添加到桌面,先换到手机自带的浏览器:', { app: inAppName() })}
      </p>
      <ol className="space-y-3">
        <Step n={1} icon={<Ellipsis size={16} />}>{fillSlots(t('点右上角的{more}'), { more: <Key><Ellipsis size={12} /></Key> })}</Step>
        <Step n={2} icon={<Compass size={16} />}>
          {fillSlots(t('选{open}'), { open: <Key>{isIOS() ? t('在 Safari 中打开') : t('在浏览器打开')}</Key> })}
          <span className="text-xs text-tx3">{t('(各 App 的叫法略有不同)')}</span>
        </Step>
        <Step n={3}>{t('在浏览器里登录后,再按提示添加到桌面')}</Step>
      </ol>
    </>
  );
}

function AndroidManualSteps() {
  return (
    <>
      <ol className="space-y-3">
        <Step n={1} icon={<EllipsisVertical size={16} />}>
          {fillSlots(t('打开浏览器菜单(右上角{dots}或底部{menu})'), { dots: <Key><EllipsisVertical size={12} /></Key>, menu: <Key>≡</Key> })}
        </Step>
        <Step n={2} icon={<SquarePlus size={16} />}>
          {fillSlots(t('找{desktop}、{home}或{install}'), {
            desktop: <Key>{t('添加到桌面')}</Key>, home: <Key>{t('添加到主屏幕')}</Key>, install: <Key>{t('安装应用')}</Key>,
          })}
        </Step>
        <Step n={3}>{t('如果提示没有权限,到手机设置里允许浏览器「创建桌面快捷方式」')}</Step>
      </ol>
      <p className="mt-3 text-xs leading-relaxed text-tx3">{t('用 Chrome 或 Edge 打开本站可以一键安装;华为、小米等手机自带的浏览器入口名称略有不同。')}</p>
    </>
  );
}

function CopyLink({ url }: { url: string }) {
  const [done, setDone] = useState(false);
  function copy() {
    if (!navigator.clipboard) { toast(t('当前环境不支持复制,请手动复制地址栏里的链接'), 'err'); return; }
    navigator.clipboard.writeText(url).then(
      () => { setDone(true); setTimeout(() => setDone(false), 1500); },
      () => toast(t('复制失败,请手动复制地址栏里的链接'), 'err'),
    );
  }
  return (
    <Button variant="outline" size="sm" onClick={copy}>
      {done ? <Check size={13} /> : <Copy size={13} />}{done ? t('已复制') : t('复制链接')}
    </Button>
  );
}

function GuideBody({ platform, onClose }: { platform: InstallPlatform; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  async function install() {
    setBusy(true);
    try {
      if (await runInstallPrompt()) { toast(t('已添加到桌面'), 'ok'); onClose(); }
    } finally { setBusy(false); }
  }

  switch (platform) {
    case 'installed':
      return (
        <div className="flex items-start gap-2.5 rounded-lg bg-ok/10 p-3 text-[13px] leading-relaxed text-tx">
          <CircleCheck size={16} className="mt-0.5 shrink-0 text-ok" />
          {isStandalone()
            ? t('现在就是以 App 方式打开的,不需要再添加。')
            : t('这台设备已经添加过了,从桌面或应用列表里的图标打开即可。')}
        </div>
      );
    case 'android-prompt':
    case 'desktop-prompt':
      return (
        <>
          <Benefits desktop={platform === 'desktop-prompt'} />
          <p className="text-[13px] leading-relaxed text-tx2">
            {platform === 'android-prompt'
              ? t('点下面的按钮,在弹出的窗口里确认即可。装好后会出现在桌面和应用列表里。')
              : t('点下面的按钮,在浏览器弹出的窗口里确认即可。')}
          </p>
          <div className="mt-4 flex justify-end">
            <Button variant="primary" size="md" disabled={busy} onClick={() => void install()}>
              {platform === 'android-prompt' ? <Smartphone size={15} /> : <MonitorDown size={15} />}
              {platform === 'android-prompt' ? t('添加到桌面') : t('安装为应用')}
            </Button>
          </div>
        </>
      );
    case 'ios-safari':
    case 'ios-other':
      return (<><Benefits /><IosSteps safari={platform === 'ios-safari'} /></>);
    case 'in-app':
      return <InAppSteps />;
    case 'android-manual':
      return (<><Benefits /><AndroidManualSteps /></>);
    case 'desktop-safari':
      return (
        <>
          <Benefits desktop />
          <ol className="space-y-3">
            <Step n={1}>{fillSlots(t('点屏幕顶部菜单栏的{file}'), { file: <Key>{t('文件')}</Key> })}</Step>
            <Step n={2}>{fillSlots(t('选{dock},再点{add}'), { dock: <Key>{t('添加到程序坞')}</Key>, add: <Key>{t('添加')}</Key> })}</Step>
          </ol>
        </>
      );
    default:
      return (
        <p className="text-[13px] leading-relaxed text-tx2">
          {t('当前浏览器不支持安装。用 Chrome 或 Edge 打开本站,地址栏右侧会出现安装图标。')}
        </p>
      );
  }
}

/** Opened from the account menu, the phone card, or a shared `/?install` link. */
export function InstallGuideHost() {
  const { guideOpen, closeGuide } = useInstall();
  const platform = useInstallPlatform();
  const desktop = platform.startsWith('desktop');
  const title = platform === 'in-app' ? t('先在浏览器中打开')
    : platform === 'ios-safari' || platform === 'ios-other' ? t('添加到主屏幕')
    : platform === 'desktop-safari' ? t('添加到程序坞')
    : desktop ? t('安装为应用') : t('添加到桌面');
  return (
    <Modal open={guideOpen} onClose={closeGuide} title={title}>
      <GuideBody platform={platform} onClose={closeGuide} />
      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
        <span className="text-xs text-tx3">
          {desktop ? t('在手机上用:把链接发到手机,打开就能看到添加步骤') : t('把这份引导发给同事')}
        </span>
        <CopyLink url={`${location.origin}/?install`} />
      </div>
    </Modal>
  );
}

/** The card at the bottom of phones and tablets (second visit on, see pwa.ts). */
export function InstallNudge() {
  const { openGuide, guideOpen } = useInstall();
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const platform = useInstallPlatform();
  const [due, setDue] = useState(false);
  // Checked once the page has settled, so a prompt that fires during load counts.
  useEffect(() => {
    const id = setTimeout(() => setDue(installNudgeDue()), 1500);
    return () => clearTimeout(id);
  }, []);
  if (!due || guideOpen || platform === 'installed' || platform.startsWith('desktop')) return null;
  // The phone drawer keeps its account button at the bottom — don't cover it.
  if (sidebarOpen && window.innerWidth < 768) return null;

  const close = () => { snoozeInstallNudge(); setDue(false); };
  const inApp = platform === 'in-app';
  const ios = platform === 'ios-safari' || platform === 'ios-other';

  async function primary() {
    if (platform !== 'android-prompt') { openGuide(); return; }
    if (await runInstallPrompt()) { toast(t('已添加到桌面'), 'ok'); setDue(false); }
  }

  return (
    <div className="fade-up fixed inset-x-3 bottom-3 z-40 rounded-xl border border-line bg-bg1 p-3.5 shadow-xl sm:inset-x-auto sm:right-4 sm:w-[380px]"
      role="dialog" aria-label={t('添加到桌面')}>
      <div className="flex items-start gap-3">
        <img src="/icon-192.png" alt="" className="h-11 w-11 shrink-0 rounded-[10px] border border-line" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-tx">
            {inApp ? t('在浏览器中打开,体验更完整') : ios ? t('添加到主屏幕,用起来像 App') : t('添加到桌面,用起来像 App')}
          </div>
          <div className="mt-0.5 text-xs leading-relaxed text-tx3">
            {inApp ? t('现在是 App 里自带的浏览器,不能添加到桌面。') : t('从桌面图标一点就开,全屏显示,不用在浏览器标签里找。')}
          </div>
        </div>
        <button type="button" title={t('关闭')} onClick={close}
          className="-mr-1 -mt-1 shrink-0 cursor-pointer rounded-sm p-1 text-tx3 hover:bg-bg2 hover:text-tx">
          <X size={16} />
        </button>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={close}>{t('以后再说')}</Button>
        <Button variant="primary" size="sm" onClick={() => void primary()}>
          {inApp ? t('怎么打开') : platform === 'android-prompt' ? t('添加到桌面') : t('看看怎么添加')}
        </Button>
      </div>
    </div>
  );
}

/** Login page inside WeChat & co.: point at the ··· menu before they sign in twice. */
export function InAppBrowserHint() {
  const [hidden, setHidden] = useState(false);
  if (hidden || !inAppHost()) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex items-start gap-2 bg-pri px-4 pb-3 pt-2 text-prifg shadow-lg">
      <p className="min-w-0 flex-1 pt-1 text-[13px] leading-relaxed">
        {isIOS()
          ? t('建议先点右上角「···」,选「在 Safari 中打开」,再登录。之后可以把本站添加到主屏幕。')
          : t('建议先点右上角「···」,选「在浏览器打开」,再登录。之后可以把本站添加到桌面。')}
        <button type="button" className="ml-2 cursor-pointer underline opacity-80" onClick={() => setHidden(true)}>{t('知道了')}</button>
      </p>
      <ArrowUpRight size={28} className="shrink-0" />
    </div>
  );
}
