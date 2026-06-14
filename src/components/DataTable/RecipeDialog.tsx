import { useMemo, useState } from 'react';
import { Sparkles, ArrowRight } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  RECIPES,
  autoMapInputs,
  resolveRecipe,
  type Recipe,
  type ResolvedRecipeColumn,
} from '@/lib/enrichment/recipes';

interface RecipeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  headers: string[];
  onApply: (columns: ResolvedRecipeColumn[]) => void;
}

const NEEDS_LABEL: Record<NonNullable<Recipe['needs']>, string> = {
  'openai-or-gemini': 'Needs OpenAI / Gemini key',
  firecrawl: 'Needs Firecrawl key',
  none: 'No API key needed',
};

/**
 * One-click enrichment recipe picker. Auto-maps recipe inputs to existing
 * CSV columns, lets the user adjust the mapping, then creates ready-to-run
 * enrichment columns.
 */
export const RecipeDialog = ({ open, onOpenChange, headers, onApply }: RecipeDialogProps) => {
  const [selectedId, setSelectedId] = useState<string>(RECIPES[0].id);
  const [inputMap, setInputMap] = useState<Record<string, string>>({});

  const recipe = useMemo(() => RECIPES.find((r) => r.id === selectedId) ?? RECIPES[0], [selectedId]);

  // (Re)initialise the input mapping whenever the recipe or headers change.
  const effectiveMap = useMemo(() => {
    const auto = autoMapInputs(recipe, headers);
    return { ...auto, ...inputMap };
  }, [recipe, headers, inputMap]);

  const selectRecipe = (id: string) => {
    setSelectedId(id);
    setInputMap({}); // fall back to auto-map for the new recipe
  };

  const requiredMissing = recipe.inputs
    .filter((i) => !i.optional)
    .some((i) => !effectiveMap[i.id]);

  const handleApply = () => {
    if (requiredMissing) return;
    onApply(resolveRecipe(recipe, effectiveMap));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Enrichment Recipes
          </DialogTitle>
          <DialogDescription>
            Pick a recipe to instantly add pre-built enrichment columns. Confirm which existing
            columns map to its inputs, then run the new columns.
          </DialogDescription>
        </DialogHeader>

        {headers.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">
            Upload a CSV first — recipes map onto your existing columns.
          </div>
        ) : (
          <div className="grid grid-cols-[200px_1fr] gap-4">
            {/* Recipe list */}
            <div className="space-y-1 border-r border-border pr-2">
              {RECIPES.map((r) => (
                <button
                  key={r.id}
                  onClick={() => selectRecipe(r.id)}
                  className={`w-full text-left rounded-md px-3 py-2 text-sm transition-colors ${
                    r.id === selectedId ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted'
                  }`}
                >
                  {r.name}
                </button>
              ))}
            </div>

            {/* Recipe detail */}
            <div className="space-y-4 min-w-0">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h4 className="font-medium">{recipe.name}</h4>
                  {recipe.needs && (
                    <Badge variant="secondary" className="text-xs">
                      {NEEDS_LABEL[recipe.needs]}
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{recipe.description}</p>
              </div>

              {/* Input mapping */}
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Map inputs to your columns
                </Label>
                {recipe.inputs.map((input) => (
                  <div key={input.id} className="flex items-center gap-2">
                    <span className="text-sm w-40 shrink-0">
                      {input.label}
                      {input.optional && <span className="text-muted-foreground"> (optional)</span>}
                    </span>
                    <Select
                      value={effectiveMap[input.id] || '__none__'}
                      onValueChange={(v) =>
                        setInputMap((prev) => ({ ...prev, [input.id]: v === '__none__' ? '' : v }))
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue placeholder="Select column…" />
                      </SelectTrigger>
                      <SelectContent>
                        {input.optional && <SelectItem value="__none__">— none —</SelectItem>}
                        {headers.map((h) => (
                          <SelectItem key={h} value={h}>
                            {h}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>

              {/* Output preview */}
              <div className="space-y-1.5">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Creates {recipe.columns.length} column{recipe.columns.length > 1 ? 's' : ''}
                </Label>
                <ul className="space-y-1">
                  {recipe.columns.map((col) => (
                    <li key={col.name} className="text-sm flex items-start gap-2">
                      <ArrowRight className="h-3.5 w-3.5 mt-0.5 shrink-0 text-primary" />
                      <span>
                        <span className="font-medium">{col.name}</span>
                        {col.note && (
                          <span className="text-xs text-muted-foreground"> — {col.note}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleApply} disabled={requiredMissing}>
                  {requiredMissing ? 'Map required inputs' : 'Add columns'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
