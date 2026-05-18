import nodemailer from 'nodemailer';
import { getPool } from './db';

export interface EmailConfig {
  id: number;
  host: string;
  port: number;
  username: string;
  password_enc: string | null;
  from_email: string;
  from_name: string;
  secure: boolean;
  enable_2fa: boolean;
}

export async function getEmailConfig(): Promise<EmailConfig | null> {
  try {
    const { rows } = await getPool().query<EmailConfig>(
      `SELECT id, host, port, username, password_enc, from_email, from_name, secure, enable_2fa
       FROM dbt_email_config LIMIT 1`
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function saveEmailConfig(cfg: Omit<EmailConfig, 'id'>): Promise<void> {
  const pool = getPool();
  const existing = await getEmailConfig();
  if (existing) {
    await pool.query(
      `UPDATE dbt_email_config SET host=$1, port=$2, username=$3, password_enc=$4,
       from_email=$5, from_name=$6, secure=$7, enable_2fa=$8, updated_at=NOW()
       WHERE id=$9`,
      [cfg.host, cfg.port, cfg.username, cfg.password_enc,
       cfg.from_email, cfg.from_name, cfg.secure, cfg.enable_2fa, existing.id]
    );
  } else {
    await pool.query(
      `INSERT INTO dbt_email_config (host, port, username, password_enc, from_email, from_name, secure, enable_2fa)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [cfg.host, cfg.port, cfg.username, cfg.password_enc,
       cfg.from_email, cfg.from_name, cfg.secure, cfg.enable_2fa]
    );
  }
}

function createTransporter(cfg: EmailConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.username ? { user: cfg.username, pass: cfg.password_enc ?? '' } : undefined,
  });
}

export async function sendEmail({ to, subject, text, html }: {
  to: string; subject: string; text: string; html?: string;
}): Promise<void> {
  const cfg = await getEmailConfig();
  if (!cfg?.host || !cfg?.from_email) throw new Error('Email is not configured');

  const transporter = createTransporter(cfg);
  await transporter.sendMail({
    from: `"${cfg.from_name}" <${cfg.from_email}>`,
    to,
    subject,
    text,
    html: html ?? `<p>${text.replace(/\n/g, '<br>')}</p>`,
  });
}

export async function testEmailConnection(cfg: Omit<EmailConfig, 'id'>): Promise<void> {
  const transporter = createTransporter(cfg as EmailConfig);
  await transporter.verify();
}

export function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
