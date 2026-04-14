export default function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: { session_id?: string; cancelled?: string };
}) {
  const cancelled = searchParams.cancelled === '1';

  if (cancelled) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 max-w-md w-full px-8 py-10 text-center">
          <div className="w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-gray-900 mb-2">Payment cancelled</h1>
          <p className="text-sm text-gray-500">
            Your payment was not completed. The payment link is still valid — please contact us if you need help.
          </p>
          <p className="mt-6 text-sm text-gray-400">
            Baker House Apartments ·{' '}
            <a href="https://www.bakerhouseapartments.cz" className="underline hover:text-gray-600">
              bakerhouseapartments.cz
            </a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 max-w-md w-full px-8 py-10 text-center">
        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
          <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">Payment successful</h1>
        <p className="text-sm text-gray-500">
          Thank you — your payment has been received. You will receive a confirmation shortly.
        </p>
        <p className="mt-6 text-sm text-gray-400">
          Baker House Apartments ·{' '}
          <a href="https://www.bakerhouseapartments.cz" className="underline hover:text-gray-600">
            bakerhouseapartments.cz
          </a>
        </p>
      </div>
    </div>
  );
}
