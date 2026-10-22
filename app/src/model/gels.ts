// Starter gel library. Hex values are approximate on-screen swatches, not measured
// transmission colours; a curated house list can replace this (DESIGN.md §13).

export interface Gel {
  code: string; // what goes on the swatch label
  name: string;
  hex: string;
  maker: "Lee" | "Rosco" | "Named";
}

const lee = (n: string, name: string, hex: string): Gel => ({ code: `L${n}`, name, hex, maker: "Lee" });
const rosco = (n: string, name: string, hex: string): Gel => ({ code: `R${n}`, name, hex, maker: "Rosco" });
const named = (code: string, name: string, hex: string): Gel => ({ code, name, hex, maker: "Named" });

export const GELS: Gel[] = [
  named("OW", "Open White", "#FFFFFF"),
  named("CTB", "Colour Temp Blue", "#BFD4FF"),
  named("CTO", "Colour Temp Orange", "#FFC27A"),
  named("TUNG", "Tungsten", "#FFC58F"),
  named("SOD", "Sodium", "#FF9A1F"),
  named("UV", "Ultraviolet", "#5B2DFF"),
  lee("002", "Rose Pink", "#FF5FA2"),
  lee("026", "Bright Red", "#D7102B"),
  lee("101", "Yellow", "#FFE14D"),
  lee("104", "Deep Amber", "#FFA51F"),
  lee("105", "Orange", "#FF7F1F"),
  lee("106", "Primary Red", "#C8102E"),
  lee("113", "Magenta", "#E0007A"),
  lee("115", "Peacock Blue", "#00A3B4"),
  lee("116", "Medium Blue-Green", "#2BB3A3"),
  lee("117", "Steel Blue", "#9FD3E8"),
  lee("119", "Dark Blue", "#1F2FA8"),
  lee("120", "Deep Blue", "#1A35C9"),
  lee("121", "LEE Green", "#8FE04A"),
  lee("124", "Dark Green", "#00995A"),
  lee("126", "Mauve", "#B0207A"),
  lee("128", "Bright Pink", "#FF2E8F"),
  lee("132", "Medium Blue", "#2A6BE0"),
  lee("139", "Primary Green", "#2E9E4F"),
  lee("141", "Bright Blue", "#2F9BE8"),
  lee("147", "Apricot", "#FF9E6B"),
  lee("158", "Deep Orange", "#FF6A13"),
  lee("164", "Flame Red", "#E8302A"),
  lee("180", "Dark Lavender", "#7A4FE0"),
  lee("181", "Congo Blue", "#2A0FA0"),
  lee("182", "Light Red", "#E8102E"),
  lee("195", "Zenith Blue", "#1F3FD9"),
  lee("200", "Double CT Blue", "#8FB0FF"),
  lee("201", "Full CT Blue", "#A9C4FF"),
  lee("202", "Half CT Blue", "#CFDDFF"),
  lee("203", "Quarter CT Blue", "#E3ECFF"),
  lee("204", "Full CT Orange", "#FFB067"),
  lee("205", "Half CT Orange", "#FFCC94"),
  lee("206", "Quarter CT Orange", "#FFE0BD"),
  rosco("26", "Light Red", "#E21B3C"),
  rosco("27", "Medium Red", "#B80F2A"),
  rosco("80", "Primary Blue", "#1F5FE0"),
  rosco("89", "Moss Green", "#3FAF5A"),
  rosco("382", "Congo Blue", "#2A0F9A"),
];

export function searchGels(query: string): Gel[] {
  const q = query.trim().toLowerCase();
  if (!q) return GELS;
  return GELS.filter((g) => g.code.toLowerCase().includes(q) || g.name.toLowerCase().includes(q));
}

/** Black or white text, whichever reads better on `hex`. */
export function textOn(hex: string): string {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.6 ? "#000000" : "#FFFFFF";
}
