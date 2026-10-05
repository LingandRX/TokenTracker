import React from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Settings } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { limitProviderIconKey, limitProviderName } from "../hooks/use-limits-display-prefs.js";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";
import {
  getXiaomiTokenPlanConfig,
  saveXiaomiTokenPlanCookie,
  clearXiaomiTokenPlanCookie,
} from "../lib/xiaomi-token-plan-api.js";

const LIMITS_SETTINGS_ICON_CLASS = "shrink-0 text-oai-gray-900 dark:text-oai-gray-200";

function ToggleSwitch({ checked, onChange, ariaLabel }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
        checked ? "bg-oai-brand-500" : "bg-oai-gray-300 dark:bg-oai-gray-700",
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

function XiaomiConfigPopover() {
  const [open, setOpen] = React.useState(false);
  const [configured, setConfigured] = React.useState(false);
  const [masked, setMasked] = React.useState(null);
  const [cookieInput, setCookieInput] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState(null);

  const loadConfig = React.useCallback(async () => {
    try {
      const res = await getXiaomiTokenPlanConfig();
      setConfigured(Boolean(res?.configured));
      setMasked(res?.maskedCookie || null);
    } catch (_e) {}
  }, []);

  React.useEffect(() => {
    if (open) {
      void loadConfig();
      setStatus(null);
    }
  }, [open, loadConfig]);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!cookieInput.trim()) return;
    setSaving(true);
    setStatus(null);
    try {
      await saveXiaomiTokenPlanCookie(cookieInput.trim());
      setStatus("saved");
      setCookieInput("");
      await loadConfig();
      window.dispatchEvent(new CustomEvent("tokentracker-refresh-limits"));
    } catch (_e) {
      setStatus("error");
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      await clearXiaomiTokenPlanCookie();
      setStatus("cleared");
      setCookieInput("");
      await loadConfig();
      window.dispatchEvent(new CustomEvent("tokentracker-refresh-limits"));
    } catch (_e) {
      setStatus("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        type="button"
        title={copy("limits.settings.config_xiaomi")}
        aria-label={copy("limits.settings.config_xiaomi")}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-oai-gray-200 dark:border-oai-gray-700 bg-white dark:bg-oai-gray-900 text-oai-gray-500 dark:text-oai-gray-400 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
      >
        <Settings className="h-3.5 w-3.5" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} side="bottom" align="end" className="z-50">
          <Popover.Popup className="w-80 rounded-xl border border-oai-gray-200 dark:border-oai-gray-700 bg-white dark:bg-oai-gray-900 p-4 shadow-xl text-left">
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-sm text-oai-gray-900 dark:text-white">
                {copy("limits.settings.xiaomi.title")}
              </span>
              <span
                className={cn(
                  "px-2 py-0.5 text-[10.5px] rounded-full font-medium",
                  configured
                    ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"
                    : "bg-oai-gray-100 dark:bg-oai-gray-800 text-oai-gray-600 dark:text-oai-gray-400",
                )}
              >
                {configured
                  ? copy("limits.settings.xiaomi.status_configured")
                  : copy("limits.settings.xiaomi.status_not_configured")}
              </span>
            </div>
            <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400 mb-3">
              {copy("limits.settings.xiaomi.desc")}
            </p>
            {masked ? (
              <div className="mb-3 rounded-md bg-oai-gray-50 dark:bg-oai-gray-800/60 p-2 font-mono text-[10.5px] text-oai-gray-600 dark:text-oai-gray-300">
                {masked}
              </div>
            ) : null}
            <form onSubmit={handleSave} className="space-y-2.5">
              <input
                type="password"
                value={cookieInput}
                onChange={(e) => setCookieInput(e.target.value)}
                placeholder={copy("limits.xiaomiTokenPlan.input.placeholder")}
                className="w-full rounded-md border border-oai-gray-300 dark:border-oai-gray-700 bg-white dark:bg-oai-gray-800 px-2.5 py-1.5 text-xs text-oai-gray-900 dark:text-oai-gray-100 placeholder:text-oai-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
              />
              <div className="flex items-center justify-between pt-1">
                {configured ? (
                  <button
                    type="button"
                    onClick={handleClear}
                    disabled={saving}
                    className="text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                  >
                    {copy("limits.settings.xiaomi.clear")}
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="submit"
                  disabled={saving || !cookieInput.trim()}
                  className="rounded-md bg-oai-brand px-3 py-1 text-xs font-medium text-white hover:bg-oai-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {saving
                    ? copy("limits.xiaomiTokenPlan.input.saving")
                    : status === "saved"
                      ? copy("limits.settings.xiaomi.saved")
                      : copy("limits.settings.xiaomi.save")}
                </button>
              </div>
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ProviderRow({ id, visible, onToggle }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  const style = {
    transform: CSS.Transform.toString(transform) || undefined,
    transition,
    zIndex: isDragging ? 20 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-3 py-2 rounded-md select-none touch-none",
        "cursor-grab active:cursor-grabbing",
        "hover:bg-oai-gray-100/60 dark:hover:bg-oai-gray-800/60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
        isDragging && "relative bg-oai-gray-100 dark:bg-oai-gray-800",
      )}
      {...attributes}
      {...listeners}
    >
      <GripVertical
        className="h-4 w-4 shrink-0 text-oai-gray-400 dark:text-oai-gray-500"
        strokeWidth={1.75}
        aria-hidden
      />

      {limitProviderIconKey(id) ? (
        <ProviderIcon
          provider={limitProviderIconKey(id)}
          size={18}
          className={cn("pointer-events-none", LIMITS_SETTINGS_ICON_CLASS)}
        />
      ) : null}

      <span className="flex-1 text-sm text-oai-gray-900 dark:text-oai-gray-200">
        {limitProviderName(id)}
      </span>

      <div onPointerDown={(e) => e.stopPropagation()} className="flex items-center gap-2">
        {id === "xiaomiTokenPlan" ? <XiaomiConfigPopover /> : null}
        <ToggleSwitch
          checked={visible}
          onChange={onToggle}
          ariaLabel={`${copy("limits.settings.toggle_visible")}: ${limitProviderName(id)}`}
        />
      </div>
    </div>
  );
}

/**
 * Bare drag-and-drop reorder + visibility list for usage-limit providers.
 * Renders only the row list — outer chrome (card, header) is supplied by the
 * surrounding container (e.g. SettingsPage SectionCard).
 *
 * Reordering runs on @dnd-kit (pointer events), not HTML5 `draggable`: the
 * Windows app hosts the dashboard in a windowless WebView2
 * (CoreWebView2CompositionController / DirectComposition), which never wires up
 * the OLE drag loop, so native `dragstart` simply never fires there (issue 387).
 * Pointer events work in every host, and this matches the other reorder UIs
 * (SortableCard, SortableColumnHeader).
 *
 * `prefs` is the return value of `useLimitsDisplayPrefs()`.
 */
export function LimitsSettingsPanel({ prefs }) {
  const { order, visibility, toggle, moveToward } = prefs;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = ({ active, over }) => {
    if (over && active.id !== over.id) moveToward(active.id, over.id);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col">
          {order.map((id) => (
            <ProviderRow
              key={id}
              id={id}
              visible={visibility[id] !== false}
              onToggle={() => toggle(id)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
