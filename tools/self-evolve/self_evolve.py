#!/usr/bin/env python3
"""
代码自生长分析工具 — 为启迪Agent提供代码进化建议
功能：检测代码坏味道，提供重构建议
"""

import ast
import sys
import json
import os
import argparse
from dataclasses import dataclass, asdict
from typing import List, Dict, Optional, Set
from datetime import datetime


@dataclass
class Suggestion:
    rule: str
    message: str
    severity: str
    line_range: Optional[tuple] = None


@dataclass
class EvolutionAction:
    action: str
    description: str
    changes: str
    success: bool


@dataclass
class CodeAnalysisResult:
    file_path: str
    line_count: int
    suggestions: List[Suggestion]
    actions: List[EvolutionAction]
    metrics: Dict = None

    def to_dict(self) -> Dict:
        result = {
            'file_path': self.file_path,
            'line_count': self.line_count,
            'suggestions': [asdict(s) for s in self.suggestions],
            'actions': [asdict(a) for a in self.actions],
            'metrics': self.metrics or {}
        }
        return result


class CodeEvolutionAnalyzer:
    """代码进化分析器"""

    def __init__(self):
        self.rules: Dict[str, bool] = {
            'duplicate': True,
            'unused-param': True,
            'long-function': True,
            'complex-calculation': True
        }

    def analyze_file(self, file_path: str, rules: List[str] = None,
                     max_lines: int = 100) -> CodeAnalysisResult:
        """分析单个文件"""
        if rules is None:
            rules = list(self.rules.keys())

        with open(file_path, 'r', encoding='utf-8') as f:
            source = f.read()

        line_count = len(source.split('\n'))
        tree = ast.parse(source, filename=file_path)

        suggestions: List[Suggestion] = []
        actions: List[EvolutionAction] = []

        # 规则1：检测过长函数
        if 'long-function' in rules and line_count > max_lines:
            suggestions.append(Suggestion(
                rule='long-function',
                message=f"文件过长 ({line_count}行)，建议拆分模块",
                severity='high',
                line_range=(1, line_count)
            ))
            actions.append(EvolutionAction(
                action='split_file',
                description=f"将文件拆分为多个模块",
                changes=f"预计减少 {line_count // 2} 行/模块",
                success=True
            ))

        # 遍历所有函数定义
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                func_name = node.name
                func_source = ast.get_source_segment(source, node) or ''
                func_lines = len(func_source.split('\n')) if func_source else 0

                # 检测未使用参数
                if 'unused-param' in rules:
                    args = [arg.arg for arg in node.args.args]
                    used: Set[str] = set()
                    for sub in ast.walk(node):
                        if isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Load):
                            used.add(sub.id)
                    unused = set(args) - used
                    if unused:
                        suggestions.append(Suggestion(
                            rule='unused-param',
                            message=f"函数 '{func_name}' 有未使用参数: {', '.join(unused)}",
                            severity='low',
                            line_range=(node.lineno, node.end_lineno)
                        ))
                        actions.append(EvolutionAction(
                            action='remove_unused_params',
                            description=f"从 '{func_name}' 移除未使用参数",
                            changes=f"移除参数: {', '.join(unused)}",
                            success=True
                        ))

                # 检测复杂计算（多行逻辑）
                if 'complex-calculation' in rules and func_lines > 30:
                    body_count = len([n for n in node.body if isinstance(n, ast.Expr)])
                    if body_count > 10:
                        suggestions.append(Suggestion(
                            rule='complex-calculation',
                            message=f"函数 '{func_name}' 逻辑过于复杂 ({body_count}条表达式)",
                            severity='medium',
                            line_range=(node.lineno, node.end_lineno)
                        ))
                        actions.append(EvolutionAction(
                            action='split_function',
                            description=f"将 '{func_name}' 拆分为子函数",
                            changes=f"预计拆分为 {body_count // 5} 个子函数",
                            success=True
                        ))

        # 检测重复代码行（简单版本）
        if 'duplicate' in rules:
            lines = source.split('\n')
            seen: Set[str] = set()
            dup_lines = []
            for i, line in enumerate(lines):
                stripped = line.strip()
                if stripped and stripped in seen:
                    dup_lines.append(i + 1)
                seen.add(stripped)

            if dup_lines:
                suggestions.append(Suggestion(
                    rule='duplicate',
                    message=f"检测到 {len(dup_lines)} 行重复代码",
                    severity='medium',
                    line_range=(min(dup_lines), max(dup_lines))
                ))
                actions.append(EvolutionAction(
                    action='extract_common_method',
                    description=f"提取重复代码为公共方法",
                    changes=f"涉及行: {dup_lines}",
                    success=True
                ))

        result = CodeAnalysisResult(
            file_path=file_path,
            line_count=line_count,
            suggestions=suggestions,
            actions=actions,
            metrics={'line_count': line_count, 'suggestion_count': len(suggestions)}
        )
        return result


def main():
    parser = argparse.ArgumentParser(description='代码自生长分析工具')
    parser.add_argument('file', help='要分析的Python文件路径')
    parser.add_argument('--rules', default='duplicate,unused-param,long-function',
                        help='要启用的规则，逗号分隔')
    parser.add_argument('--max-lines', type=int, default=100,
                        help='长函数的阈值行数')
    parser.add_argument('--auto-action', action='store_true',
                        help='自动应用进化动作（生成重构后代码）')
    parser.add_argument('--task-id', default='default', help='任务ID')

    args = parser.parse_args()

    # 验证文件存在
    if not os.path.exists(args.file):
        print(f"错误: 文件不存在: {args.file}", file=sys.stderr)
        sys.exit(1)

    # 解析规则
    rules = [r.strip() for r in args.rules.split(',')]

    # 执行分析
    analyzer = CodeEvolutionAnalyzer()
    result = analyzer.analyze_file(args.file, rules, args.max_lines)

    # 输出结果（JSON格式，供适配器解析）
    output = {
        'task_id': args.task_id,
        'timestamp': datetime.now().isoformat(),
        'file': args.file,
        'line_count': result.line_count,
        'suggestion_count': len(result.suggestions),
        'action_count': len(result.actions),
        'suggestions': result.to_dict()['suggestions'],
        'actions': result.to_dict()['actions'],
        'metrics': result.to_dict()['metrics']
    }

    print(json.dumps(output, indent=2, ensure_ascii=False))

    # 如果要求自动应用，尝试生成重构后代码
    if args.auto_action and result.actions:
        evolved_file = args.file.replace('.py', '_evolved.py')
        with open(evolved_file, 'w', encoding='utf-8') as f:
            f.write("# 自动进化后的代码 - 任务: {args.task_id}\n")
            f.write(f"# 分析时间: {output['timestamp']}\n")
            f.write(f"# 建议数: {result.to_dict()['suggestion_count']}\n")
            f.write(f"# 原始文件: {args.file}\n\n")
            f.write("# 重构建议：\n")
            for s in result.to_dict()['suggestions']:
                f.write(f"# [{s['severity']}] {s['rule']}: {s['message']}\n")
            f.write("\n# 请根据上述建议手动应用重构，或使用完整的AST修改器\n")

        print(f"\n重构后代码草稿已保存至: {evolved_file}")


if __name__ == '__main__':
    main()