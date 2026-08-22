import type { Metadata } from 'next'
import AeadNonceReuseSimulator from '../../../components/attacks/AeadNonceReuseSimulator'
import Navbar from '../../../components/layout/Navbar'
import Footer from '../../../components/layout/footer'

export const metadata: Metadata = {
  title: 'AEAD Nonce-Reuse Catastrophe Lab | CryptoViz',
  description:
    'The AES-GCM "forbidden attack": reuse a nonce, recover the GHASH authentication key H as a GF(2¹²⁸) square root, and forge a tag the real verifier accepts — step by step.',
}

export default function AeadNonceReusePage() {
  return (
    <div className="flex min-h-screen flex-col bg-slate-950">
      <Navbar />
      <main className="flex-1">
        <AeadNonceReuseSimulator />
      </main>
      <Footer />
    </div>
  )
}
