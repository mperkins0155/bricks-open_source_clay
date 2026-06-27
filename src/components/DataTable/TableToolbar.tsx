import { useState } from 'react';
import { Upload, Plus, Settings2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  getEnrichmentSettings,
  saveEnrichmentSettings,
  type EnrichmentSettings,
} from '@/lib/enrichment/runner';
import { isRateLimitEnabled, setRateLimitEnabled } from '@/lib/enrichment/rateLimiter';

interface TableToolbarProps {
  onUploadCSV: () => void;
  onAddColumn: () => void;
  onOpenRecipes: () => void;
}

/**
 * Toolbar component for DataTable with action buttons and enrichment settings.
 * The settings popover controls concurrency, retries, and skip-already-filled —
 * the knobs that keep large enrichment runs from tripping provider rate limits.
 */
export const TableToolbar = ({ onUploadCSV, onAddColumn, onOpenRecipes }: TableToolbarProps) => {
  const [settings, setSettings] = useState<EnrichmentSettings>(() => getEnrichmentSettings());
  const [rateLimit, setRateLimit] = useState<boolean>(() => isRateLimitEnabled());

  const update = (patch: Partial<EnrichmentSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveEnrichmentSettings(patch);
  };

  return (
    <div className="flex items-center justify-between p-4 border-b border-border">
      <h3 className="font-semibold">Data Table</h3>
      <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="flex items-center gap-2">
              <Settings2 className="h-4 w-4" />
              Enrichment
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80" align="end">
            <div className="space-y-4">
              <div>
                <h4 className="font-medium text-sm">Enrichment Settings</h4>
                <p className="text-xs text-muted-foreground">
                  Tune throughput and reliability for column runs.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="concurrency" className="text-xs">
                  Parallel rows (concurrency)
                </Label>
                <Input
                  id="concurrency"
                  type="number"
                  min={1}
                  max={50}
                  value={settings.concurrency}
                  onChange={(e) =>
                    Number.isFinite(e.target.valueAsNumber) && update({ concurrency: e.target.valueAsNumber })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Lower = gentler on API rate limits. 3–5 is safe for OpenAI; raise for local Ollama.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="retries" className="text-xs">
                  Retries per row
                </Label>
                <Input
                  id="retries"
                  type="number"
                  min={0}
                  max={8}
                  value={settings.maxRetries}
                  onChange={(e) => update({ maxRetries: Number(e.target.value) })}
                />
                <p className="text-xs text-muted-foreground">
                  Auto-retries rate-limit / network errors with exponential backoff.
                </p>
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5 pr-2">
                  <Label htmlFor="skip-filled" className="text-xs">
                    Skip already-enriched cells
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Re-runs only empty / errored cells — saves API spend.
                  </p>
                </div>
                <Switch
                  id="skip-filled"
                  checked={settings.skipFilled}
                  onCheckedChange={(checked) => update({ skipFilled: checked })}
                />
              </div>

              <div className="flex items-center justify-between border-t border-border pt-3">
                <div className="space-y-0.5 pr-2">
                  <Label htmlFor="rate-limit" className="text-xs">
                    Auto rate-limit (prevent 429s)
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Paces requests per provider and backs off on rate-limit responses.
                  </p>
                </div>
                <Switch
                  id="rate-limit"
                  checked={rateLimit}
                  onCheckedChange={(checked) => {
                    setRateLimit(checked);
                    setRateLimitEnabled(checked);
                  }}
                />
              </div>
            </div>
          </PopoverContent>
        </Popover>

        <Button
          variant="outline"
          size="sm"
          onClick={onOpenRecipes}
          className="flex items-center gap-2"
        >
          <Sparkles className="h-4 w-4" />
          Recipes
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={onUploadCSV}
          className="flex items-center gap-2"
        >
          <Upload className="h-4 w-4" />
          Upload New CSV
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex items-center gap-2"
          onClick={onAddColumn}
        >
          <Plus className="h-4 w-4" />
          Add Column
        </Button>
      </div>
    </div>
  );
};
