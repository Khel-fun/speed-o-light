import { ModeToggle } from "./mode-toggle";

export default function Header() {
  return (
    <div>
      <div className="flex flex-row items-center justify-between px-4 py-2">
        <span className="text-sm font-black italic tracking-tighter text-neutral-400">
          SPEED-O-LIGHT
        </span>
        <ModeToggle />
      </div>
      <hr className="border-neutral-800" />
    </div>
  );
}
