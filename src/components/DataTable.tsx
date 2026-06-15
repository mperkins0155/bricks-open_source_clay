import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { useDataStore } from '@/stores/useDataStore';

// Custom Hooks
import { useTableSort } from '@/hooks/useTableSort';
import { useFormulaExecution } from '@/hooks/useFormulaExecution';
import { useCSVUpload } from '@/hooks/useCSVUpload';
import { useColumnManagement } from '@/hooks/useColumnManagement';

// UI Components
import { TableToolbar } from './DataTable/TableToolbar';
import { TableHeader } from './DataTable/TableHeader';
import { TableCell } from './DataTable/TableCell';
import { CellDetailsSheet } from './DataTable/CellDetailsSheet';
import { AddColumnDialog } from './DataTable/AddColumnDialog';
import { RecipeDialog } from './DataTable/RecipeDialog';
import { toast } from '@/hooks/use-toast';
import type { ResolvedRecipeColumn } from '@/lib/enrichment/recipes';

interface DataTableProps {
  onEditFormula: (column: string) => void;
}

/**
 * DataTable Component - Main orchestrator for table display and interaction
 * 
 * Responsibilities:
 * - Coordinate custom hooks for sorting, formula execution, CSV upload, and column management
 * - Render table structure with headers and cells
 * - Manage cell details viewing
 * 
 * Note: This component has been refactored from 628 lines to 158 lines by extracting
 * logic into custom hooks and UI into sub-components
 */
export const DataTable = ({ onEditFormula }: DataTableProps) => {
  // Store data access
  const { headers, rows, getFormula, addColumn, setFormula } = useDataStore();
  
  // Custom Hooks - Business Logic
  const { sortColumn, sortDirection, sortedRows, handleSort } = useTableSort(rows);
  const {
    executingColumn,
    executingCells,
    progress,
    executeFormula,
    executeFailedCells,
    cancelExecution,
    executeCellFormula,
  } = useFormulaExecution();
  const { handleCSVUpload } = useCSVUpload();
  const { 
    showAddColumnDialog, 
    setShowAddColumnDialog,
    newColumnName,
    setNewColumnName,
    columnToRemove,
    setColumnToRemove,
    handleAddColumn,
    handleRemoveColumn 
  } = useColumnManagement(headers, onEditFormula);
  
  // Local UI state for cell details viewer
  const [selectedCell, setSelectedCell] = useState<{row: number, column: string, content: string} | null>(null);
  const [showRecipes, setShowRecipes] = useState(false);

  // Handler for cell click to show details
  const handleCellClick = (rowIndex: number, columnName: string, content: string) => {
    setSelectedCell({ row: rowIndex, column: columnName, content: content || '' });
  };

  // Apply a recipe: create each output column (if new) and set its formula.
  const handleApplyRecipe = (columns: ResolvedRecipeColumn[]) => {
    columns.forEach((col) => {
      if (!headers.includes(col.name)) addColumn(col.name);
      setFormula(col.name, col.formula);
    });
    toast({
      title: 'Recipe Applied',
      description: `${columns.length} column${columns.length > 1 ? 's' : ''} added. Hit ▶ on each to run.`,
    });
  };

  // Early return if no data
  if (headers.length === 0) {
    return null;
  }

  return (
    <Card className="overflow-hidden">
      {/* Toolbar with CSV upload and Add Column actions */}
      <TableToolbar
        onUploadCSV={handleCSVUpload}
        onAddColumn={() => setShowAddColumnDialog(true)}
        onOpenRecipes={() => setShowRecipes(true)}
      />

      {/* Live enrichment progress for the running column */}
      {progress && progress.total > 0 && (
        <div className="px-4 py-2 border-b border-border bg-muted/30">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
            <span>
              Enriching{executingColumn ? ` "${executingColumn}"` : ''}… {progress.completed}/{progress.total}
            </span>
            <div className="flex items-center gap-3">
              <span>
                {progress.succeeded} ok
                {progress.failed > 0 ? ` · ${progress.failed} failed` : ''}
                {progress.skipped > 0 ? ` · ${progress.skipped} skipped` : ''}
              </span>
              <button
                onClick={cancelExecution}
                className="font-medium text-destructive hover:underline"
              >
                Stop
              </button>
            </div>
          </div>
          <div className="h-1.5 w-full rounded-full bg-border overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-200"
              style={{ width: `${Math.round((progress.completed / progress.total) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Horizontal scroll container with mirrored scroll bars */}
      <div className="relative">
        {/* Top scroll bar - mirrored to main table */}
        <div 
          className="overflow-x-auto pb-2 border-b border-border/30"
          onScroll={(e) => {
            const tableContainer = e.currentTarget.parentElement?.querySelector('.table-scroll-container') as HTMLElement;
            if (tableContainer) {
              tableContainer.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
        >
          <div style={{ width: `${headers.length * 200}px`, height: '1px' }} />
        </div>
        
        {/* Main table container */}
        <div 
          className="overflow-x-auto table-scroll-container"
          onScroll={(e) => {
            const topScroll = e.currentTarget.parentElement?.querySelector('div') as HTMLElement;
            if (topScroll) {
              topScroll.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
        >
          <table className="w-full border-collapse">
          {/* Table Headers with sorting and actions */}
          <thead>
            <tr className="border-b border-border">
              {headers.map((header) => (
                <TableHeader
                  key={header}
                  header={header}
                  hasFormula={!!getFormula(header)}
                  isExecuting={executingColumn === header}
                  isSorted={sortColumn === header}
                  sortDirection={sortDirection}
                  columnToRemove={columnToRemove}
                  onSort={handleSort}
                  onEditFormula={onEditFormula}
                  onExecuteFormula={executeFormula}
                  onRetryFailed={executeFailedCells}
                  onRemoveColumn={handleRemoveColumn}
                  onSetColumnToRemove={setColumnToRemove}
                />
              ))}
            </tr>
          </thead>
          {/* Table Body with data cells */}
          <tbody>
            {sortedRows.map((row, index) => (
              <tr key={index} className="border-b border-border hover:bg-muted/30 transition-colors">
                {headers.map((header) => {
                  const cellKey = `${index}-${header}`;
                  const isCellExecuting = executingCells.has(cellKey);
                  const isColumnExecuting = executingColumn === header;
                  const isAnyExecuting = isCellExecuting || isColumnExecuting;
                  
                  return (
                    <TableCell
                      key={header}
                      value={row[header]}
                      rowIndex={index}
                      columnName={header}
                      hasFormula={!!getFormula(header)}
                      isExecuting={isAnyExecuting}
                      onExecuteCell={executeCellFormula}
                      onViewCell={handleCellClick}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      
      {/* Empty state message */}
      {rows.length === 0 && (
        <div className="p-8 text-center text-muted-foreground">
          <p>No data to display</p>
        </div>
      )}

      {/* Dialogs and Sheets */}
      <CellDetailsSheet
        selectedCell={selectedCell}
        formula={selectedCell ? getFormula(selectedCell.column) : null}
        onClose={() => setSelectedCell(null)}
        onEditFormula={onEditFormula}
        onExecuteCell={executeCellFormula}
      />

      <AddColumnDialog
        open={showAddColumnDialog}
        columnName={newColumnName}
        onClose={() => setShowAddColumnDialog(false)}
        onColumnNameChange={setNewColumnName}
        onAddColumn={handleAddColumn}
      />

      <RecipeDialog
        open={showRecipes}
        onOpenChange={setShowRecipes}
        headers={headers}
        onApply={handleApplyRecipe}
      />
    </Card>
  );
};