"use client";

import { LoaderCircle, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { Switch } from "radix-ui";
import { useId, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { useLocale, useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { deleteAccount, updateAccountSettings } from "@/server/actions/accounts";
import type { EntityKind } from "@/domain/accounts/classification";

export interface EntityOption {
  id: string;
  name: string;
  kind: EntityKind;
}

interface AccountSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: { accountId: string; name: string; entityId: string; includeInNetWorth: boolean };
  entities: EntityOption[];
  transactionCount: number;
}

const NEW_ENTITY = "__new__";

export function AccountSettingsSheet({ open, onOpenChange, account, entities, transactionCount }: AccountSettingsSheetProps) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const id = useId();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(account.name);
  const [entityId, setEntityId] = useState(account.entityId);
  const [newEntityName, setNewEntityName] = useState("");
  const [newEntityKind, setNewEntityKind] = useState<"business" | "shared">("business");
  const [includeInNetWorth, setIncludeInNetWorth] = useState(account.includeInNetWorth);
  const creating = entityId === NEW_ENTITY;
  const valid = name.trim().length > 0 && (!creating || newEntityName.trim().length > 0);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    startTransition(async () => {
      const r = await updateAccountSettings({
        accountId: account.accountId,
        name,
        includeInNetWorth,
        entity: creating ? { mode: "new", name: newEntityName, kind: newEntityKind } : { mode: "existing", entityId },
      });
      if (r.ok) {
        toast.success(t("common.saved"));
        onOpenChange(false);
      } else toast.error(t("common.somethingWrong"));
    });
  }

  function onDelete() {
    startTransition(async () => {
      const r = await deleteAccount(account.accountId);
      if (r.ok) {
        toast.success(t("explore.accountDeleted", { count: r.removed.transactions }));
        onOpenChange(false);
        router.replace(`/${locale}/explore`);
      } else toast.error(t("common.somethingWrong"));
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("explore.editAccount")} description={t("explore.editAccountHint")} closeLabel={t("common.close")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-6 px-6 pt-2 pb-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-name`}>{t("explore.accountName")}</Label>
          <Input id={`${id}-name`} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} required />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-[13px] font-medium text-fg-muted">{t("common.entity")}</legend>
          <div className="flex flex-col gap-1.5">
            {entities.map((entity) => (
              <EntityRadio key={entity.id} name={`${id}-entity`} checked={entityId === entity.id} onSelect={() => setEntityId(entity.id)}>
                <span className="text-[14.5px] text-fg">{entity.kind === "personal" && entity.name === "Personal" ? t("common.personal") : entity.name}</span>
                <span className="text-[12px] text-fg-subtle">{t(`common.${entity.kind}`)}</span>
              </EntityRadio>
            ))}
            <EntityRadio name={`${id}-entity`} checked={creating} onSelect={() => setEntityId(NEW_ENTITY)}>
              <span className="inline-flex items-center gap-1.5 text-[14.5px] text-fg">
                <Plus className="size-4" aria-hidden />
                {t("explore.newEntity")}
              </span>
            </EntityRadio>
          </div>
          {creating ? (
            <div className="mt-2 flex flex-col gap-3 rounded-2xl bg-surface p-4 hairline">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-entity-name`}>{t("explore.entityName")}</Label>
                <Input
                  id={`${id}-entity-name`}
                  value={newEntityName}
                  maxLength={80}
                  onChange={(e) => setNewEntityName(e.target.value)}
                  placeholder={t("explore.entityNamePlaceholder")}
                  className="bg-bg-elevated"
                />
              </div>
              <Segmented
                size="sm"
                label={t("explore.entityKind")}
                value={newEntityKind}
                onChange={setNewEntityKind}
                options={[
                  { value: "business", label: t("common.business") },
                  { value: "shared", label: t("common.shared") },
                ]}
              />
            </div>
          ) : null}
        </fieldset>

        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor={`${id}-networth`} className="text-[14.5px] text-fg">
              {t("explore.includeInNetWorth")}
            </Label>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-subtle">{t("explore.includeInNetWorthHint")}</p>
          </div>
          <Switch.Root
            id={`${id}-networth`}
            checked={includeInNetWorth}
            onCheckedChange={setIncludeInNetWorth}
            className="relative h-7 w-12 shrink-0 rounded-full bg-border-strong transition-colors data-[state=checked]:bg-positive"
          >
            <Switch.Thumb className="block size-5 translate-x-1 rounded-full bg-bg-elevated shadow-soft transition-transform data-[state=checked]:translate-x-6" />
          </Switch.Root>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!valid || pending}>
            {pending ? <LoaderCircle className="animate-spin" /> : null}
            {t("common.save")}
          </Button>
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-6">
          <p className="flex items-start gap-2 text-[13px] leading-relaxed text-fg-muted">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            {t("explore.deleteAccountHint", { count: transactionCount })}
          </p>
          {confirmingDelete ? (
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={pending} onClick={() => setConfirmingDelete(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="button" variant="danger" disabled={pending} onClick={onDelete}>
                {pending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
                {t("common.deletePermanently")}
              </Button>
            </div>
          ) : (
            <Button type="button" variant="outline" className="self-start text-negative" onClick={() => setConfirmingDelete(true)}>
              <Trash2 />
              {t("explore.deleteAccount")}
            </Button>
          )}
        </div>
      </form>
    </Sheet>
  );
}

function EntityRadio({ name, checked, onSelect, children }: { name: string; checked: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-2xl px-4 py-3 transition hairline has-[:focus-visible]:shadow-[0_0_0_3px_var(--accent-soft)]",
        checked ? "bg-accent-soft" : "bg-surface hover:bg-surface-2",
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="size-4 accent-[var(--accent)]" />
      <span className="flex min-w-0 flex-1 items-center justify-between gap-3">{children}</span>
    </label>
  );
}
