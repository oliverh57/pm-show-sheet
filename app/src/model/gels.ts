// Starter gel library. Hex values are approximate on-screen swatches, not measured
// transmission colours; a curated house list can replace this (DESIGN.md §13).

export interface Gel {
  code: string; // maker's number, e.g. L201 (searchable, shown small)
  name: string;
  label: string; // what goes on the swatch, the Sheet and the deck: "Steel Blue", "CTB", "½ CTO"
  hex: string;
  maker: "Lee" | "Rosco" | "Named";
  pie?: string[]; // a multi-colour "gel" (rainbow), drawn as equal slices
}

const lee = (n: string, name: string, hex: string, label = name): Gel => ({ code: `L${n}`, name, label, hex, maker: "Lee" });
const rosco = (n: string, name: string, hex: string, label = name): Gel => ({ code: `R${n}`, name, label, hex, maker: "Rosco" });
const named = (code: string, name: string, hex: string, label = name): Gel => ({ code, name, label, hex, maker: "Named" });

export const GELS: Gel[] = [
  { ...named("RGB", "RGB Rainbow", "#FFFFFF"), pie: ["#FF0000", "#00FF00", "#0000FF"] },
  { ...named("CMY", "CMY Rainbow", "#FFFFFF"), pie: ["#00FFFF", "#FF00FF", "#FFFF00"] },
  named("OW", "Open White", "#FFFFFF"),
  named("CTB", "Colour Temp Blue", "#BFD4FF", "CTB"),
  named("CTO", "Colour Temp Orange", "#FFC27A", "CTO"),
  named("TUNG", "Tungsten", "#FFC58F"),
  named("SOD", "Sodium", "#FF9A1F"),
  named("UV", "Ultraviolet", "#5B2DFF", "UV"),
  named("WW", "Warm White", "#FFE8C8"),
  named("CW", "Cool White", "#E8F0FF"),
  named("DW", "Dirty White", "#EDE3CC"),
  named("DRED", "Deep Red", "#A0001C"),
  named("CLIN", "Clinical Green", "#9CFFC8"),
  named("SEA", "Sea Green", "#2EC4A0"),
  named("3200", "3200K", "#FFCB8E"),
  named("5600", "5600K", "#F2F4FF"),
  named("CNDL", "Candlelight", "#FFB15C"),
  named("FIRE", "Firelight", "#FF7A1A"),
  named("MOON", "Moonlight", "#B8C8FF"),
  named("RED", "Red", "#FF0000"),
  named("GRN", "Green", "#00FF00"),
  named("BLU", "Blue", "#0000FF"),
  named("BABY", "Baby Blue", "#A7D8F5"),
  named("POWD", "Powder Blue", "#B8D8E8"),
  named("ICE", "Ice Blue", "#D6F1FF"),
  named("ARCT", "Arctic Blue", "#8FD8FF"),
  named("ELEC", "Electric Blue", "#0080FF"),
  named("ROYL", "Royal Blue", "#2340D0"),
  named("COBT", "Cobalt", "#0047AB"),
  named("NAVY", "Navy", "#101C70"),
  named("MIDN", "Midnight Blue", "#0B1450"),
  named("PERI", "Periwinkle", "#8C9BFF"),
  named("CYAN", "Cyan", "#00E0FF"),
  named("AQUA", "Aqua", "#4FFFE6"),
  named("TURQ", "Turquoise", "#20D6C7"),
  named("TEAL", "Teal", "#008C8C"),
  named("MINT", "Mint", "#A8FFD6"),
  named("SAGE", "Sage", "#A3C4A0"),
  named("EMER", "Emerald", "#00A86B"),
  named("OLIV", "Olive", "#7D8A2E"),
  named("CHRT", "Chartreuse", "#C6FF2E"),
  named("ACID", "Acid Green", "#A8FF00"),
  named("NEOG", "Neon Green", "#39FF14"),
  named("PIST", "Pistachio", "#B9E39A"),
  named("LEMN", "Lemon", "#FFF44F"),
  named("BUTR", "Butter", "#FFF1A8"),
  named("GOLD", "Gold", "#FFC21A"),
  named("MUST", "Mustard", "#E0A800"),
  named("CHMP", "Champagne", "#F7E3B5"),
  named("CRM", "Cream", "#FFF4D6"),
  named("AMBR", "Amber", "#FFB000"),
  named("PEAC", "Peach", "#FFB98A"),
  named("CORL", "Coral", "#FF6F5E"),
  named("SALM", "Salmon", "#FF8C7A"),
  named("TERR", "Terracotta", "#D2643C"),
  named("RUST", "Rust", "#B7410E"),
  named("BORG", "Burnt Orange", "#CC5500"),
  named("BLDO", "Blood Orange", "#E8401C"),
  named("COPR", "Copper", "#C8743A"),
  named("BRNZ", "Bronze", "#B07A2A"),
  named("RGLD", "Rose Gold", "#E8A99B"),
  named("CRIM", "Crimson", "#C0102F"),
  named("CHER", "Cherry", "#D2042D"),
  named("BURG", "Burgundy", "#7A0F2A"),
  named("WINE", "Wine", "#5E0B24"),
  named("HOTP", "Hot Pink", "#FF2EA6"),
  named("NEOP", "Neon Pink", "#FF10C8"),
  named("BUBB", "Bubblegum", "#FF8CC6"),
  named("BPNK", "Baby Pink", "#FFC4DC"),
  named("BLSH", "Blush", "#F7C6C7"),
  named("FUCH", "Fuchsia", "#FF00C8"),
  named("RASP", "Raspberry", "#D0156B"),
  named("PLUM", "Plum", "#7B2A6E"),
  named("VIOL", "Violet", "#8A2BE2"),
  named("PURP", "Purple", "#6A0DAD"),
  named("LILC", "Lilac", "#C8A2E8"),
  lee("002", "Rose Pink", "#FF5FA2"),
  lee("004", "Medium Bastard Amber", "#FFC9A0"),
  lee("007", "Pale Yellow", "#FFF6C2"),
  lee("008", "Dark Salmon", "#FF7F5C"),
  lee("009", "Pale Amber Gold", "#FFD48A"),
  lee("010", "Medium Yellow", "#FFE600"),
  lee("013", "Straw Tint", "#FFE7B0"),
  lee("015", "Deep Straw", "#FFC400"),
  lee("017", "Surprise Peach", "#E89A7A"),
  lee("019", "Fire", "#FF4A12"),
  lee("020", "Medium Amber", "#FFAE52"),
  lee("021", "Gold Amber", "#FF9230"),
  lee("022", "Dark Amber", "#FF6F1A"),
  lee("024", "Scarlet", "#F21D3A"),
  lee("025", "Sunset Red", "#FF5A3A"),
  lee("026", "Bright Red", "#D7102B"),
  lee("035", "Light Pink", "#FFC2D0"),
  lee("036", "Medium Pink", "#FF9AB8"),
  lee("046", "Dark Magenta", "#C8006A"),
  lee("048", "Rose Purple", "#C860D8"),
  lee("052", "Light Lavender", "#D6B8F0"),
  lee("058", "Lavender", "#9A70D8"),
  lee("061", "Mist Blue", "#D8E8F5"),
  lee("063", "Pale Blue", "#C2DDF5"),
  lee("068", "Sky Blue", "#4F9BF0"),
  lee("079", "Just Blue", "#2F5BE8"),
  lee("088", "Lime Green", "#C8F06A", "Pale Lime"),
  lee("090", "Dark Yellow Green", "#2E8A1F"),
  lee("100", "Spring Yellow", "#F2F04A"),
  lee("101", "Yellow", "#FFE14D"),
  lee("102", "Light Amber", "#FFD27A"),
  lee("103", "Straw", "#FFEBC2"),
  lee("104", "Deep Amber", "#FFA51F"),
  lee("105", "Orange", "#FF7F1F"),
  lee("106", "Primary Red", "#C8102E"),
  lee("107", "Light Rose", "#FFA8B8"),
  lee("108", "English Rose", "#F5B8A8"),
  lee("110", "Middle Rose", "#FF8FB8"),
  lee("111", "Dark Pink", "#FF5C9A"),
  lee("113", "Magenta", "#E0007A"),
  lee("115", "Peacock Blue", "#00A3B4"),
  lee("116", "Medium Blue-Green", "#2BB3A3"),
  lee("117", "Steel Blue", "#9FD3E8"),
  lee("118", "Light Blue", "#3FB8F0"),
  lee("119", "Dark Blue", "#1F2FA8"),
  lee("120", "Deep Blue", "#1A35C9"),
  lee("121", "LEE Green", "#8FE04A", "Lime Green"),
  lee("122", "Fern Green", "#5ACB4A"),
  lee("124", "Dark Green", "#00995A"),
  lee("126", "Mauve", "#B0207A"),
  lee("128", "Bright Pink", "#FF2E8F"),
  lee("132", "Medium Blue", "#2A6BE0"),
  lee("134", "Golden Amber", "#FF8A3A"),
  lee("136", "Pale Lavender", "#E2CFF0"),
  lee("137", "Special Lavender", "#B9A8F0"),
  lee("138", "Pale Green", "#D8F5A8"),
  lee("139", "Primary Green", "#2E9E4F"),
  lee("140", "Summer Blue", "#6FC8F0"),
  lee("141", "Bright Blue", "#2F9BE8"),
  lee("147", "Apricot", "#FF9E6B"),
  lee("148", "Bright Rose", "#F0306A"),
  lee("152", "Pale Gold", "#FFD8B0"),
  lee("156", "Chocolate", "#B88A6A"),
  lee("158", "Deep Orange", "#FF6A13"),
  lee("161", "Slate Blue", "#7AA8D8"),
  lee("162", "Bastard Amber", "#FFDCC2"),
  lee("164", "Flame Red", "#E8302A"),
  lee("165", "Daylight Blue", "#5FB0F0"),
  lee("170", "Deep Lavender", "#B88AE0"),
  lee("172", "Lagoon Blue", "#18B8C8"),
  lee("174", "Dark Steel Blue", "#5F9FE0"),
  lee("176", "Loving Amber", "#FFB8A0"),
  lee("179", "Chrome Orange", "#FFA020"),
  lee("180", "Dark Lavender", "#7A4FE0"),
  lee("181", "Congo Blue", "#2A0FA0"),
  lee("182", "Light Red", "#E8102E"),
  lee("183", "Moonlight Blue", "#2F8FE8"),
  lee("195", "Zenith Blue", "#1F3FD9"),
  lee("197", "Alice Blue", "#5A7FE0"),
  lee("198", "Palace Blue", "#3A3FC0"),
  lee("199", "Regal Blue", "#4A4FD8"),
  lee("200", "Double CT Blue", "#8FB0FF", "Double CTB"),
  lee("201", "Full CT Blue", "#A9C4FF", "CTB"),
  lee("202", "Half CT Blue", "#CFDDFF", "½ CTB"),
  lee("203", "Quarter CT Blue", "#E3ECFF", "¼ CTB"),
  lee("204", "Full CT Orange", "#FFB067", "CTO"),
  lee("205", "Half CT Orange", "#FFCC94", "½ CTO"),
  lee("206", "Quarter CT Orange", "#FFE0BD", "¼ CTO"),
  lee("323", "Jade", "#2FB88A"),
  lee("327", "Forest Green", "#1F6B34"),
  lee("328", "Follies Pink", "#FF3FB0"),
  lee("332", "Special Rose Pink", "#F0408A"),
  lee("345", "Fuchsia Pink", "#E870C8"),
  lee("353", "Lighter Blue", "#8FD0F0"),
  lee("366", "Cornflower", "#8FB8F0"),
  lee("707", "Ultimate Violet", "#5A1FC8"),
  lee("709", "Electric Lilac", "#A8B0F5"),
  lee("711", "Cold Blue", "#A8C0E0"),
  lee("721", "Berry Blue", "#2F6FD8"),
  lee("724", "Ocean Blue", "#2FA8D8"),
  lee("725", "Old Steel Blue", "#B0D0E0"),
  lee("728", "Steel Green", "#A8D0B8"),
  lee("729", "Scuba Blue", "#008FA0"),
  lee("730", "Liberty Green", "#7AD8B8"),
  lee("733", "Damson Violet", "#4A2FA0"),
  lee("735", "Velvet Green", "#0F6F3A"),
  lee("740", "Aurora Borealis Green", "#4F7A2A"),
  lee("778", "Millennium Gold", "#FF9A2A"),
  lee("789", "Blood Red", "#9A0A1A"),
  lee("790", "Moroccan Pink", "#F0A8B0"),
  lee("797", "Deep Purple", "#5A0FA0"),
  rosco("17", "Light Flame", "#FF8A5A"),
  rosco("18", "Flame", "#FF7A3A"),
  rosco("25", "Orange Red", "#FF4A1F"),
  rosco("26", "Light Red", "#E21B3C"),
  rosco("27", "Medium Red", "#B80F2A"),
  rosco("33", "No Color Pink", "#FFC8D0"),
  rosco("42", "Deep Salmon", "#FF6A5A"),
  rosco("47", "Light Rose Purple", "#C878C8"),
  rosco("49", "Medium Purple", "#9A1FB8"),
  rosco("51", "Surprise Pink", "#D8B8E8"),
  rosco("59", "Indigo", "#3F1FA8"),
  rosco("62", "Booster Blue", "#B8D8FF"),
  rosco("64", "Light Steel Blue", "#7FB8F0"),
  rosco("69", "Brilliant Blue", "#1F8FE0"),
  rosco("70", "Nile Blue", "#7FD8F0"),
  rosco("74", "Night Blue", "#1F2FB0"),
  rosco("77", "Green Blue", "#1F7FC8"),
  rosco("80", "Primary Blue", "#1F5FE0"),
  rosco("86", "Pea Green", "#7AC83A"),
  rosco("88", "Light Green", "#B8F08A"),
  rosco("89", "Moss Green", "#3FAF5A"),
  rosco("93", "Blue Green", "#00A898"),
  rosco("382", "Congo Blue", "#2A0F9A"),
];

/** Short words people type for the words in gel names: "mid blue" finds Medium Blue, "lt steel" Light Steel Blue. */
const ALIASES: Record<string, string[]> = {
  mid: ["mid", "medium"], med: ["med", "medium"], lt: ["light"], dk: ["dark", "deep"], dark: ["dark", "deep"], deep: ["deep", "dark"],
  grey: ["grey", "gray"], gray: ["gray", "grey"], colour: ["colour", "color"], color: ["color", "colour"],
};

/** Gels for a search: the text anywhere in the code, name or label, or every word typed (allowing for ALIASES) in it. */
export function searchGels(query: string): Gel[] {
  const q = query.trim().toLowerCase();
  if (!q) return GELS;
  const words = q.split(/\s+/);
  return GELS.filter((g) => {
    const text = `${g.code} ${g.name} ${g.label}`.toLowerCase();
    return text.includes(q) || words.every((w) => (ALIASES[w] ?? [w]).some((a) => text.includes(a)));
  });
}

/** A swatch label saved as a gel code ("L201") by older versions, as its name ("CTB"). */
export function gelLabelFor(label: string | undefined): string | undefined {
  return GELS.find((g) => g.code === label)?.label ?? label;
}

/** CSS background for a swatch: its colour, or its pie slices split evenly around the centre. */
export function swatchFill(sw: { hex: string; pie?: string[] }): string {
  if (!sw.pie?.length) return sw.hex;
  const step = 360 / sw.pie.length;
  return `conic-gradient(${sw.pie.map((c, i) => `${c} ${i * step}deg ${(i + 1) * step}deg`).join(", ")})`;
}

/** Text colour for a swatch's label (white, shadowed in CSS, on a pie). */
export function swatchText(sw: { hex: string; pie?: string[] }): string {
  return sw.pie?.length ? "#FFFFFF" : textOn(sw.hex);
}

/** Black or white text, whichever reads better on `hex`. */
export function textOn(hex: string): string {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.6 ? "#000000" : "#FFFFFF";
}
