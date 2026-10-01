/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: "/privacy",
        destination: "https://pulserouter.com/privacy",
        permanent: true,
      },
    ];
  },
};

module.exports = nextConfig;
