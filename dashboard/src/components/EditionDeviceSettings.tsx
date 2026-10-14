export interface EditionDeviceSettingsProps {
  deviceId: string;
  isAdmin: boolean;
  tags: string[];
}

/** Edition extension slot; Community has no additional device settings. */
export function EditionDeviceSettings(_props: EditionDeviceSettingsProps) { return null; }
