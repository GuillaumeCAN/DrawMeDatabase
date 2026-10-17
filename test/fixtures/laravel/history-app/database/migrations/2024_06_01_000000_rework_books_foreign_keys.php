<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('books', function (Blueprint $table) {
            $table->renameColumn('writer_id', 'author_id');
            $table->dropForeign('books_editor_id_foreign');
            $table->dropConstrainedForeignId('reviewer_id');
            $table->index('title');
            $table->unique('isbn');
            $table->dropTimestamps();
        });
    }

    public function down(): void
    {
        Schema::table('books', function (Blueprint $table) {
            $table->timestamps();
            $table->dropUnique(['isbn']);
            $table->dropIndex(['title']);
            $table->foreignId('reviewer_id')->nullable()->constrained('authors');
            $table->foreign('editor_id')->references('id')->on('authors');
            $table->renameColumn('author_id', 'writer_id');
        });
    }
};
