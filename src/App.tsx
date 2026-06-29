const App = () => {
  return (
    <div className="p-12 flex flex-col items-center bg-black text-white text-center w-96">
      <img src="/icons/icon128.png" className="" />
      <h1 className="text-xl font-bold">Mobbin Unveiled</h1>
      <div className="text-xs text-gray-400 flex space-x-1 items-center">
        <p>by Chirag Bhandakkar</p>
      </div>
      <a
        href="https://github.com/chiraagbhandakkar/mobbin-unveiled"
        target="_blank"
        className="p-4"
      >
        <img src="/images/github-white.svg" className="h-10" />
      </a>
    </div>
  );
};

export default App;
