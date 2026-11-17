import { useEffect, useState } from "react";
import type { Settings } from "talos-shared";
import { fetchSettings, saveSettings } from "@/api";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export const SettingsView = () => {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    fetchSettings().then(setSettings);
  }, []);

  const changeAllowNewPeople = async (allowNewPeople: boolean) => {
    setSettings(await saveSettings({ allowNewPeople }));
  };

  return (
    <div className="px-4 lg:px-6">
      <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
        <Label htmlFor="allow-new-people">Let new people sign up</Label>
        <Switch
          id="allow-new-people"
          checked={settings?.allowNewPeople ?? false}
          disabled={!settings}
          onCheckedChange={changeAllowNewPeople}
        />
      </div>
    </div>
  );
};
