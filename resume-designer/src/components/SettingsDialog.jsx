import { useCallback, useEffect, useState } from 'react';
import {
  Sun, Moon, Monitor, Eye, EyeOff, X,
  SlidersHorizontal, Sparkles, RefreshCw, Database, BarChart3,
} from 'lucide-react';

import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { confirmDestructive } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';

import { getSettings, saveSettings } from '../persistence.js';
import { refreshChatPanel } from '../chatPanel.js';
import { getTheme, setTheme } from '../theme.js';
import {
  isTauri, getAppInfo, getUpdateChannel, setUpdateChannel,
  getAutoUpdateCheck, setAutoUpdateCheck,
} from '../native.js';
import {
  getUsageSummary, getUsageByDate, exportUsageData, clearUsageData,
  formatTokenCount, formatCost,
} from '../tokenTrackingService.js';
import { triggerManualUpdateCheck } from '../updateFlow.js';
import { useUpdateBusy } from '../hooks/useUpdateBusy.js';
import { ChangelogHistory } from './ChangelogHistory.jsx';
import { exportFullBackupWithFeedback, importBackupFromFile, importLegacyElectronWithFeedback } from '../backupFlow.js';

// Settings panel — composed from genuine shadcn primitives following shadcn's own
// settings/forms patterns: a left nav rail (ghost items, terracotta-tinted active
// `bg-primary/10 text-primary` per the approved mockup), the shared `Segmented`
// control for the appearance/theme picker (muted track + white sliding pill),
// real `Separator`s between sections, and the mockup's type scale (group-title
// 14px, group-sub/row-hint 12.5px). No bespoke per-panel CSS. Opens on the
// `rd:open-settings` event (header gear + chat gears, via settingsModal.js's
// openSettings() shim with a {tab} deep-link — chat deep-links to `api-keys`).
// Destructive actions confirm via the shared AlertDialog host (confirmDestructive).

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

// Tab order matches the original settings modal. Updates is desktop-only.
const TABS = [
  { id: 'general', label: 'General', Icon: SlidersHorizontal },
  { id: 'api-keys', label: 'AI', Icon: Sparkles },
  ...(isTauri ? [{ id: 'updates', label: 'Updates', Icon: RefreshCw }] : []),
  { id: 'data', label: 'Data', Icon: Database },
  { id: 'usage', label: 'Usage', Icon: BarChart3 },
];

// Section heading + optional muted description. Geometry pinned to the mockup's
// design-system tokens: group-title 14px/600, group-sub 12.5px muted.
function SectionHeader({ title, description }) {
  return (
    <div className={cn(description ? 'mb-3.5' : 'mb-3')}>
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {description && <p className="mt-0.5 text-[12.5px] leading-[1.5] text-muted-foreground">{description}</p>}
    </div>
  );
}

// A settings row: label + optional description on the left, control on the right.
// Mockup: rowx-label 13.5px/500, rowx-hint 12.5px muted (max-w 380px).
function SettingRow({ label, description, htmlFor, children }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={htmlFor} className="text-[13.5px] font-medium">{label}</Label>
        {description && <p className="max-w-[380px] text-[12.5px] leading-[1.45] text-muted-foreground">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// One of the four Usage stat cards.
function StatCard({ label, value, accent }) {
  return (
    <div className="rounded-lg border bg-card p-3 text-center">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold tabular-nums', accent ? 'text-primary' : 'text-foreground')}>
        {value}
      </div>
    </div>
  );
}

// A breakdown table for the Usage tab, styled with shadcn Table primitives.
function UsageTable({ headers, rows }) {
  return (
    <div className="max-h-[200px] overflow-auto rounded-lg border">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow className="hover:bg-transparent">
            {headers.map((h, i) => (
              <TableHead key={h} className={cn('h-9', i > 0 && 'text-right')}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={headers.length} className="py-6 text-center text-muted-foreground">
                No usage data yet
              </TableCell>
            </TableRow>
          ) : rows.map((cells, i) => (
            <TableRow key={i}>
              {cells.map((c, j) => (
                <TableCell key={j} className={cn(j === 0 ? 'font-medium' : 'text-right tabular-nums')}>{c}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('general');

  // Form/display state, seeded from the services each time the dialog opens.
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [autoFallback, setAutoFallback] = useState(false);
  const [theme, setThemeState] = useState('system');
  const [channel, setChannel] = useState('stable');
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [version, setVersion] = useState('—');
  const [usage, setUsage] = useState(null);
  const updateBusy = useUpdateBusy();

  const refreshUsage = useCallback(() => {
    setUsage({ summary: getUsageSummary(), byDate: getUsageByDate() });
  }, []);

  // Seed all fields from persisted state.
  const seed = useCallback(() => {
    const s = getSettings();
    setApiKey(s.openrouterKey || '');
    setAutoFallback(!!s.autoFallback);
    setThemeState(getTheme());
    if (isTauri) {
      setChannel(getUpdateChannel());
      setAutoUpdate(getAutoUpdateCheck());
      getAppInfo().then((info) => setVersion(info?.version || '—')).catch(() => {});
    }
    refreshUsage();
  }, [refreshUsage]);

  // Open via the gears (window event), seeding to the requested tab.
  useEffect(() => {
    const onOpen = (e) => {
      seed();
      setTab(e.detail?.tab || 'general');
      setOpen(true);
    };
    window.addEventListener('rd:open-settings', onOpen);
    return () => window.removeEventListener('rd:open-settings', onOpen);
  }, [seed]);

  // Keep the theme selection in sync if it's changed elsewhere.
  useEffect(() => {
    const onThemeChange = (e) => setThemeState(e.detail?.theme ?? getTheme());
    window.addEventListener('themechange', onThemeChange);
    return () => window.removeEventListener('themechange', onThemeChange);
  }, []);

  const pickTheme = (value) => { setTheme(value); setThemeState(value); };

  const handleSaveKeys = () => {
    saveSettings({ openrouterKey: apiKey, autoFallback });
    refreshChatPanel();
    setOpen(false);
  };

  const handleClearKeys = async () => {
    const ok = await confirmDestructive({
      title: 'Clear all API keys?',
      description: 'Are you sure you want to clear all API keys?',
      actionLabel: 'Clear All Keys',
    });
    if (!ok) return;
    saveSettings({ openrouterKey: '' });
    refreshChatPanel();
    setApiKey('');
  };

  const handleExportUsage = () => {
    const blob = new Blob([exportUsageData()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `token-usage-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleClearUsage = async () => {
    const ok = await confirmDestructive({
      title: 'Clear usage data?',
      description: 'Are you sure you want to clear all usage data? This cannot be undone.',
      actionLabel: 'Clear Data',
    });
    if (!ok) return;
    clearUsageData();
    refreshUsage();
  };

  const pickChannel = (value) => { setUpdateChannel(value); setChannel(value); };
  const toggleAutoUpdate = (checked) => { setAutoUpdateCheck(checked); setAutoUpdate(checked); };

  const summary = usage?.summary;
  const totalCalls = summary ? Object.values(summary.byModel).reduce((n, m) => n + m.calls, 0) : 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] w-[90vw] max-w-3xl flex-col gap-0 overflow-hidden p-0 glass-card"
      >
        <DialogDescription className="sr-only">Manage your preferences and account.</DialogDescription>

        {/* Header */}
        <div className="flex shrink-0 items-start justify-between p-6">
          <div className="space-y-1">
            <DialogTitle>Settings</DialogTitle>
            <p className="text-sm text-muted-foreground">Manage your preferences and account.</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="rounded-sm text-muted-foreground opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </button>
        </div>

        {/* Body: nav rail + content. Rail active item is terracotta-tinted
            (bg-primary/10 text-primary) per the mockup; inactive is ghost/muted.
            Rail item geometry: 13.5px/500, gap-9px, py-1.5/px-2.5, rounded-md. */}
        <div className="grid min-h-0 flex-1 grid-cols-[190px_1fr] border-t">
          <nav className="flex flex-col gap-0.5 bg-muted/30 p-3.5">
            {TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13.5px] font-medium transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
                  tab === id
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon /> {label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 overflow-y-auto p-6">
            {/* General */}
            {tab === 'general' && (
              <div className="space-y-6">
                <section>
                  <SectionHeader title="Appearance" description="Customize how Resume Designer looks on this device." />
                  <Label className="mb-2 block text-[13.5px] font-medium">Theme</Label>
                  <Segmented className="flex w-full">
                    {THEME_OPTIONS.map(({ value, label, Icon }) => (
                      <SegmentedItem
                        key={value}
                        active={theme === value}
                        onClick={() => pickTheme(value)}
                        className="flex-1"
                      >
                        <Icon /> {label}
                      </SegmentedItem>
                    ))}
                  </Segmented>
                </section>

                {isTauri && (
                  <>
                    <Separator />
                    <section>
                      <SectionHeader title="Updates" />
                      <SettingRow
                        htmlFor="settings-auto-update"
                        label="Check for updates on launch"
                        description="Automatically look for new versions when the app starts."
                      >
                        <Switch id="settings-auto-update" checked={autoUpdate} onCheckedChange={toggleAutoUpdate} />
                      </SettingRow>
                    </section>
                  </>
                )}

                <Separator />
                <section>
                  <SectionHeader title="Onboarding" />
                  <SettingRow
                    label="Replay welcome guide"
                    description="Re-run the first-time setup wizard. Your resumes and settings are kept."
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setOpen(false); window.showOnboardingWizard?.(); }}
                    >
                      Replay
                    </Button>
                  </SettingRow>
                </section>

                <Separator />
                <section>
                  <SectionHeader title="About" />
                  <SettingRow label="Version">
                    <Badge variant="secondary">Resume Designer {version}</Badge>
                  </SettingRow>
                </section>
              </div>
            )}

            {/* AI */}
            {tab === 'api-keys' && (
              <div className="space-y-6">
                <section className="space-y-2">
                  <Label htmlFor="settings-openrouter-key">OpenRouter API Key</Label>
                  <div className="flex gap-2">
                    <Input
                      id="settings-openrouter-key"
                      className="flex-1 font-mono"
                      type={showKey ? 'text' : 'password'}
                      placeholder="sk-or-v1-..."
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      title="Show/hide key"
                      aria-label="Show/hide key"
                      onClick={() => setShowKey((v) => !v)}
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Your key is stored locally and is sent only to OpenRouter — never share it. One key covers Claude,
                    GPT, Gemini and 300+ models. Get a key at openrouter.ai/keys
                  </p>
                </section>

                <Separator />
                <section>
                  <SettingRow
                    htmlFor="settings-auto-fallback"
                    label="Automatic fallback"
                    description="Retry an alternate model if the chosen one is unavailable or rate-limited."
                  >
                    <Switch id="settings-auto-fallback" checked={autoFallback} onCheckedChange={setAutoFallback} />
                  </SettingRow>
                </section>

                <Separator />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={handleClearKeys}>Clear All Keys</Button>
                  <Button type="button" onClick={handleSaveKeys}>Save Settings</Button>
                </div>
              </div>
            )}

            {/* Updates (desktop only) */}
            {isTauri && tab === 'updates' && (
              <div className="space-y-6">
                <section className="space-y-2.5">
                  <Label>Update channel</Label>
                  <Tabs value={channel} onValueChange={pickChannel}>
                    <TabsList>
                      <TabsTrigger value="stable">Stable</TabsTrigger>
                      <TabsTrigger value="beta">Beta</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <p className="text-sm text-muted-foreground">
                    Beta installs pre-release builds from the{' '}
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">next</code> branch.
                    Stable installs only versioned releases.
                  </p>
                  <div className="pt-2">
                    <SettingRow htmlFor="settings-auto-update-2" label="Check for updates automatically on launch">
                      <Switch id="settings-auto-update-2" checked={autoUpdate} onCheckedChange={toggleAutoUpdate} />
                    </SettingRow>
                  </div>
                </section>

                <Separator />
                <section>
                  <SectionHeader title="Check now" description={`Current version: ${version}`} />
                  <Button type="button" variant="outline" onClick={triggerManualUpdateCheck} disabled={updateBusy}>
                    {updateBusy ? 'Checking…' : 'Check for Updates'}
                  </Button>
                </section>

                <Separator />
                <section>
                  <SectionHeader title="What's new" description="Recent releases." />
                  <ChangelogHistory />
                </section>
              </div>
            )}

            {/* Data */}
            {tab === 'data' && (
              <section>
                <SectionHeader
                  title="Backup & restore"
                  description="Save or restore all resumes, settings, job descriptions, and history as a single JSON file."
                />
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={exportFullBackupWithFeedback}>Export Full Backup</Button>
                  <Button asChild variant="outline">
                    <label className="cursor-pointer">
                      Import Backup…
                      <input
                        type="file"
                        accept="application/json,.json"
                        hidden
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = ''; // allow re-selecting the same file
                          if (file) importBackupFromFile(file);
                        }}
                      />
                    </label>
                  </Button>
                </div>
                {isTauri && (
                  <div className="mt-6">
                    <SectionHeader
                      title="Import from a previous installation"
                      description="If you used the older desktop (Electron) version on this computer, bring its resumes, settings, job descriptions, and history into this app."
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" onClick={() => importLegacyElectronWithFeedback('merge')}>
                        Merge previous data
                      </Button>
                      <Button type="button" variant="outline" onClick={() => importLegacyElectronWithFeedback('replace')}>
                        Replace with previous data
                      </Button>
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* Usage */}
            {tab === 'usage' && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-3">
                  <StatCard label="Total Input" value={summary ? formatTokenCount(summary.totalInputTokens) : '0'} />
                  <StatCard label="Total Output" value={summary ? formatTokenCount(summary.totalOutputTokens) : '0'} />
                  <StatCard label="Est. Cost" value={summary ? formatCost(summary.totalCost) : '$0.00'} accent />
                  <StatCard label="API Calls" value={String(totalCalls)} />
                </div>

                <section>
                  <SectionHeader title="Usage by Model" />
                  <UsageTable
                    headers={['Model', 'Calls', 'Input', 'Output', 'Cost']}
                    rows={summary ? Object.values(summary.byModel).sort((a, b) => b.cost - a.cost).map((d) => [d.model, d.calls, formatTokenCount(d.inputTokens), formatTokenCount(d.outputTokens), formatCost(d.cost)]) : []}
                  />
                </section>

                <section>
                  <SectionHeader title="Usage by Feature" />
                  <UsageTable
                    headers={['Feature', 'Calls', 'Input', 'Output', 'Cost']}
                    rows={summary ? Object.entries(summary.byFeature).sort((a, b) => b[1].cost - a[1].cost).map(([feature, d]) => [feature, d.calls, formatTokenCount(d.inputTokens), formatTokenCount(d.outputTokens), formatCost(d.cost)]) : []}
                  />
                </section>

                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={handleExportUsage}>Export Data</Button>
                  <Button type="button" variant="outline" onClick={handleClearUsage}>Clear Data</Button>
                  <Button type="button" onClick={refreshUsage}>Refresh</Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
