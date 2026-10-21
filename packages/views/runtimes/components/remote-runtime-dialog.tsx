"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@multica/ui/components/ui/dialog";
import { useT } from "../../i18n";
import { QoderConfiguration } from "./qoder-configuration";

/** Connects or manages the workspace's Qoder Cloud Agent connection. */
export function RemoteRuntimeDialog({
  onClose,
  configure = false,
}: {
  onClose: () => void;
  /** The connection already exists; title the dialog as managing it. */
  configure?: boolean;
}) {
  const { t } = useT("runtimes");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {configure
              ? t(($) => $.qoder.credentials_title)
              : t(($) => $.qoder.connect_title)}
          </DialogTitle>
          <DialogDescription>
            {configure
              ? t(($) => $.qoder.credentials_description)
              : t(($) => $.qoder.connect_description)}
          </DialogDescription>
        </DialogHeader>
        <QoderConfiguration />
      </DialogContent>
    </Dialog>
  );
}
