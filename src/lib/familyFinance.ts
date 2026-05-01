export type Role = "ayah" | "ibu";
export type EntryType = "income" | "expense" | "bill" | "debt" | "receivable" | "note" | "shopping";
export type EntryStatus = "open" | "paid" | "deleted";

export type ParsedEntry = {
  type: EntryType;
  title: string;
  amount: number;
  category?: string;
  metadata?: Record<string, unknown>;
};

export type FinanceEntry = ParsedEntry & {
  id: string;
  status: EntryStatus;
  entry_date: string;
  created_at: string;
};

// Capture numbers with optional thousand separators (1.050.000 / 1,050,000) or decimals with unit (1,5jt)
const moneyPattern = /(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?|\d+)\s?(rb|ribu|jt|juta|k|m)?/i;

export const formatRupiah = (value: number) =>
  new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value || 0);

export const parseAmount = (text: string) => {
  const normalized = text.toLowerCase().replace(/rp\.?\s?/g, "");
  const match = normalized.match(moneyPattern);
  if (!match) return 0;
  const rawStr = match[1];
  const unit = match[2]?.toLowerCase();
  let raw: number;
  // If contains multiple separators OR a single separator followed by exactly 3 digits → thousand separator
  const sepCount = (rawStr.match(/[.,]/g) || []).length;
  const looksLikeThousands = sepCount >= 2 || /^\d{1,3}([.,])\d{3}$/.test(rawStr);
  if (looksLikeThousands && !unit) {
    raw = Number(rawStr.replace(/[.,]/g, ""));
  } else {
    // Treat single separator as decimal (e.g. "1,5jt" or "1.5jt")
    raw = Number(rawStr.replace(",", "."));
  }
  if (unit === "rb" || unit === "ribu" || unit === "k") return Math.round(raw * 1000);
  if (unit === "jt" || unit === "juta" || unit === "m") return Math.round(raw * 1000000);
  return Math.round(raw);
};


const cleanTitle = (text: string) =>
  text
    .toLowerCase()
    .replace(/rp\.?\s?/g, "")
    .replace(moneyPattern, "")
    .replace(/^(catat|makan|bayar|beli|belanja|tagihan|hutang ke|piutang dari|gaji|pemasukan|pengeluaran)\s*/i, "")
    .replace(/[:—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const parseFinanceText = (input: string): ParsedEntry | null => {
  const text = input.trim();
  const lower = text.toLowerCase();
  const amount = parseAmount(text);

  if (lower.startsWith("catat belanja")) {
    const items = text.replace(/^catat belanja\s*:?\s*/i, "").trim();
    return { type: "shopping", title: items || "Daftar belanja", amount: 0, category: "belanja", metadata: { items } };
  }

  if (lower.startsWith("catat ")) {
    const body = text.replace(/^catat\s*/i, "");
    const [categoryRaw, ...rest] = body.split(":");
    const title = rest.join(":").trim() || categoryRaw.trim();
    return { type: "note", title: title || "Catatan", amount, category: categoryRaw.trim() || "catatan" };
  }

  if (lower.includes("tagihan")) return { type: "bill", title: cleanTitle(text) || "Tagihan", amount, category: "tagihan" };
  if (lower.includes("hutang")) return { type: "debt", title: cleanTitle(text) || "Hutang", amount, category: "hutang" };
  if (lower.includes("piutang")) return { type: "receivable", title: cleanTitle(text) || "Piutang", amount, category: "piutang" };
  if (lower.includes("gaji") || lower.includes("pemasukan")) return { type: "income", title: cleanTitle(text) || "Pemasukan", amount, category: "pemasukan" };
  if (amount > 0) return { type: "expense", title: cleanTitle(text) || "Pengeluaran", amount, category: "pengeluaran" };

  return null;
};

export const buildAssistantReply = (query: string, entries: FinanceEntry[]) => {
  const lower = query.toLowerCase();
  const active = entries.filter((entry) => entry.status !== "deleted");
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const scoped = lower.includes("hari ini")
    ? active.filter((entry) => entry.entry_date === today)
    : lower.includes("bulan ini")
      ? active.filter((entry) => entry.entry_date?.startsWith(month))
      : active;

  const income = scoped.filter((entry) => entry.type === "income").reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const expense = scoped.filter((entry) => ["expense", "bill", "debt", "shopping"].includes(entry.type)).reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const receivable = scoped.filter((entry) => entry.type === "receivable" && entry.status === "open").reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const balance = income + receivable - expense;

  if (lower.includes("hutang")) {
    const debts = active.filter((entry) => entry.type === "debt" && entry.status === "open");
    return debts.length ? `Hutang aktif: ${debts.map((entry) => `${entry.title} ${formatRupiah(Number(entry.amount))}`).join(", ")}.` : "Tidak ada hutang aktif.";
  }

  if (lower.includes("tagihan")) {
    const bills = active.filter((entry) => entry.type === "bill" && entry.status === "open");
    return bills.length ? `Tagihan aktif: ${bills.map((entry) => `${entry.title} ${formatRupiah(Number(entry.amount))}`).join(", ")}.` : "Tidak ada tagihan aktif.";
  }

  if (lower.includes("catatan")) {
    const notes = active.filter((entry) => entry.type === "note" || entry.type === "shopping").slice(0, 6);
    return notes.length ? `Catatan terakhir: ${notes.map((entry) => entry.title).join(" • ")}.` : "Belum ada catatan.";
  }

  return `Ringkasan ${lower.includes("hari ini") ? "hari ini" : lower.includes("bulan ini") ? "bulan ini" : "keluarga"}: pemasukan ${formatRupiah(income)}, pengeluaran ${formatRupiah(expense)}, saldo ${formatRupiah(balance)}.`;
};

export const isReportQuery = (text: string) => /^(saldo|laporan|hari ini|bulan ini|hutang|tagihan|catatan)$/i.test(text.trim());
