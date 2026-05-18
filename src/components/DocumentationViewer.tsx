import React, { useState } from 'react';
import { X, Copy, Download, Check } from 'lucide-react';

interface Props {
  title: string;
  content: string;
  format: 'markdown' | 'csv' | 'sql' | 'svg' | 'canvas';
  onClose: () => void;
}

export default function DocumentationViewer({ title, content, format, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleDownload = () => {
    const ext = { markdown: 'md', csv: 'csv', sql: 'sql', svg: 'svg', canvas: 'json' }[format];
    const mime = {
      markdown: 'text/markdown',
      csv: 'text/csv',
      sql: 'text/plain',
      svg: 'image/svg+xml',
      canvas: 'application/json',
    }[format];
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `migration.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="font-bold text-gray-800">{title}</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg transition-colors"
            >
              {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors"
            >
              <Download size={14} />
              Download
            </button>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors text-gray-500"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          <pre className="text-xs font-mono text-gray-700 whitespace-pre-wrap leading-relaxed">
            {content}
          </pre>
        </div>
      </div>
    </div>
  );
}
