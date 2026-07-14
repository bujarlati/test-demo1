import { ArrowLeft, BookOpenText } from "lucide-react";
import { Link } from "react-router-dom";

export function NotFoundPage() {
  return <main className="not-found"><BookOpenText size={34} /><span>404</span><h1>这一页还没有写进正史</h1><p>它可能属于另一个分支，或已经被收进旧版本。</p><Link className="button button--primary" to="/"><ArrowLeft size={17} /> 回到书架</Link></main>;
}
