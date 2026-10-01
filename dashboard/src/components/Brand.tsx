/** C1 / Flow identity. Use the transparent inverse mark on the dark dashboard. */
export function Brand({ size = 32, showName = true }: { size?: number; showName?: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-3 text-(--foreground)">
      {/* A static SVG needs neither raster optimization nor an external request. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="brand-dark" src="/brand/deviceyard-mark-dark.svg" width={size} height={size} alt={showName ? "" : "DeviceYard"} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="brand-light" src="/brand/deviceyard-mark.svg" width={size} height={size} alt={showName ? "" : "DeviceYard"} />
      {showName && <span className="text-xl font-semibold tracking-tight">Device<span className="text-[#00bfa6]">Yard</span></span>}
    </span>
  );
}
