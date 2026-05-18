import React from 'react';

export function LoadingSpinner({ message = 'Loading...' }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4">
      <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      <p className="text-gray-500 text-sm">{message}</p>
    </div>
  );
}

export function ErrorAlert({ title, message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-4">
      {title && <h3 className="font-semibold text-red-800 mb-1">{title}</h3>}
      <p className="text-red-700 text-sm">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 text-sm bg-red-100 hover:bg-red-200 text-red-800 px-3 py-1 rounded transition-colors"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function SuccessAlert({ message }: { message: string }) {
  return (
    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
      <p className="text-green-800 text-sm font-medium">{message}</p>
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="text-4xl mb-4">📭</div>
      <h3 className="text-lg font-semibold text-gray-700">{title}</h3>
      {description && <p className="text-gray-400 text-sm mt-1 max-w-sm">{description}</p>}
    </div>
  );
}
